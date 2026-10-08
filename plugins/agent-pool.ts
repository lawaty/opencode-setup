import { tool, type Plugin, type PluginOptions } from "@opencode-ai/plugin"
import * as pool from "../lib/pool.ts"

// Routes any pooled agent type (explore-fast, implement-fast, context-manager)
// onto a shared set of free models, and keeps the pool off models that are
// known to be unusable right now.
//
// The pool's models are not written here. They live in pool-models.json, and the
// config hook rewrites the variant agents (explore-fast-N, ...) and the provider
// whitelists in opencode.jsonc from that file, so changing the pool is a one-file
// edit instead of editing twelve agent definitions. The models in opencode.jsonc
// are defaults that this plugin overwrites.
//
// A spawn of a pooled base type is rewritten to <base>-<slot>, where the slot is
// chosen by live in-flight load counted per MODEL across every agent type. So
// explore-fast and implement-fast compete for the same capacity instead of each
// protecting its own, and total pressure per model stays balanced. Load is
// shared across processes too: each process publishes only its own claims to
// ~/.local/share/opencode/agent-pool/claims.<id>.json, so no locking is needed.
//
// Two agent types reach the pool differently. explore-fast and implement-fast
// arrive as task tool calls, so they are rewritten here. context-manager is
// spawned by context-autoupdate through the session API and never passes through
// the task hook, so that plugin borrows a slot from this module directly.
//
// Limits are handled in three layers, because a usage-limited request does not
// fail -- it hangs, so the caller never regains control and the claim is never
// released. There is no upstream quota API (the server exposes 162 endpoints,
// none for usage; api.opencode.ai answers "Not Found" on every usage path), so a
// limit cannot be predicted before the very first request. Instead:
//
//   1. catalog  -- GET /api/model exposes per-model status (active | deprecated),
//                  so a model opencode has retired is never chosen.
//   2. strikes  -- the event hook sees assistant messages carrying an APIError,
//                  which names providerID/modelID directly and carries
//                  responseHeaders (retry-after) plus responseBody. Each hit
//                  writes a cooldown file that every process reads before
//                  routing. Backoff is exponential; where the provider states
//                  "Resets in 35min" that duration is used instead of guessing.
//   3. watchdog -- a hang is silent: no error event, no log line, no message
//                  delta. So an in-flight claim older than STUCK_MIN_AGE_MS whose
//                  target session has been silent for STUCK_IDLE_MS is presumed
//                  wedged. That session is aborted, returning control to the
//                  caller, freeing the slot, and cooling the model.

const SERVICE = "agent-pool"
const REAP_INTERVAL_MS = 30_000
const HANG_FALLBACK_MS = 10 * 60 * 1000

export const AgentPool = (async ({ client, serverUrl }, options?: PluginOptions) => {
  const opts = (options ?? {}) as { id?: string; dir?: string; reapMs?: number; modelsFile?: string }
  const s = pool.state(opts)

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: SERVICE, level, message, extra } }).catch(() => {})

  const warnOnce = async (message: string) => {
    if (s.warned.has(message)) return
    s.warned.add(message)
    await log("warn", message)
  }

  pool.init(s, (m) => void warnOnce(m))

  const abortSession = async (sessionID: string) => {
    if (!serverUrl) return false
    try {
      await fetch(new URL(`/session/${sessionID}/abort`, serverUrl).toString(), { method: "POST" })
      return true
    } catch {
      return false
    }
  }

  const reapStuck = async () => {
    if (s.reaping) return
    s.reaping = true
    s.lastSweep = Date.now()
    try {
      const stuck = pool.findStuck(s)
      if (stuck.length === 0) return
      pool.releaseStuck(s, stuck.map((x) => x.key))
      for (const { claim } of stuck) {
        const killed = claim.g ? await abortSession(claim.g) : false
        s.reaped++
        await log(
          "warn",
          `hung ${claim.v} on ${claim.m} after ${Math.round((Date.now() - claim.t) / 1000)}s with ${Math.round(pool.idleFor(s, claim, Date.now()) / 1000)}s of silence; ${killed ? `aborted session ${claim.g}` : "no session to abort"}`,
          { base: claim.v, model: claim.m, slot: claim.k, session: claim.g, aborted: killed },
        )
        const prior = s.cooling.get(claim.m)
        const now = Date.now()
        const strike = pool.recordStrike(s, claim.m, "hang", prior && prior.until > now ? prior.until - now : HANG_FALLBACK_MS)
        if (strike) await log("warn", `cooling ${claim.m} for ${Math.round((strike.until - now) / 1000)}s (hang)`)
      }
    } catch (error) {
      await log("error", `reaper failed: ${String(error)}`)
    } finally {
      s.reaping = false
    }
  }

  // The reaper must not depend on new work arriving: a task that hangs while the
  // session is otherwise idle would otherwise hold its slot until the TTL. It
  // also runs once at startup so a task left hanging by a previous process is
  // cleaned up rather than waiting a full interval.
  pool.refreshCatalog(s, serverUrl)
  const reapMs = opts.reapMs ?? REAP_INTERVAL_MS
  void reapStuck()
  const timer = setInterval(() => void reapStuck(), reapMs)
  timer.unref?.()
  void log(
    "info",
    `reaper armed: every ${Math.round(reapMs / 1000)}s, aborts a claim older than ${Math.round(pool.STUCK_MIN_AGE_MS / 60000)}m whose target has been silent ${Math.round(pool.STUCK_IDLE_MS / 60000)}m`,
  )

  return {
    config: async (cfg) => {
      const slots = pool.ensureSlots(s, (m) => void warnOnce(m))
      const agents = cfg.agent as Record<string, { model?: string; [k: string]: unknown }> | undefined
      const providers = cfg.provider as Record<string, { whitelist?: string[] }> | undefined
      const known = new Set<string>()
      for (const [name, def] of Object.entries(cfg.agent ?? {})) if (def?.model) s.models.set(name, def.model)

      for (const slot of slots) {
        // The variant agents carry no model in opencode.jsonc: it is injected
        // here from pool-models.json, so that file is the only place a pool model
        // is written down. A model still present in the config is a stale leftover
        // and is reported, not obeyed.
        for (const base of pool.BASES) {
          const name = pool.agentFor(base, slot.index)
          const def = agents?.[name]
          if (!def) {
            await warnOnce(`variant ${name} missing from opencode.jsonc; spawns of ${base} that route to slot ${slot.index} would fail`)
            continue
          }
          if (def.model && def.model !== slot.model) {
            await warnOnce(`${name} still hard-codes ${def.model} in opencode.jsonc; pool-models.json wins (${slot.model}). Delete the line to keep one source of truth.`)
          }
          def.model = slot.model
          known.add(name)
          s.models.set(name, slot.model)
        }

        // opencode deletes every model a provider offers that is not whitelisted,
        // so a slot whose model is missing from the whitelist silently resolves to
        // no model at all. Add it instead of making the user edit a second file.
        // Split on the first slash only: some providers (openrouter) put a vendor
        // segment in the model id itself, e.g. openrouter/nvidia/nemotron-3-ultra:free.
        const slash = slot.model.indexOf("/")
        const provider = slot.model.slice(0, slash)
        const id = slot.model.slice(slash + 1)
        const entry = providers?.[provider]
        if (!entry) {
          await warnOnce(`provider ${provider} is not configured in opencode.jsonc; slot ${slot.index} (${slot.model}) cannot resolve`)
          continue
        }
        const list = (entry.whitelist ??= [])
        if (!list.includes(id)) {
          list.push(id)
          await log("info", `whitelisted ${id} on ${provider} (pool-models.json slot ${slot.index})`)
        }
      }
      s.known = known
      await log(
        "info",
        `pool-models.json: bound ${known.size} variant agent(s) to ${slots.length} slot(s): ${slots.map((sl) => `${sl.index}=${sl.model} w${sl.weight}`).join(", ")}`,
      )
    },

    event: async ({ event }) => {
      try {
        const props = (event as { type?: string; properties?: Record<string, unknown> }).properties ?? {}

        // opencode reports free-tier exhaustion itself, per session: a retry
        // status carrying action.reason "free_tier_limit", the provider, and a
        // `next` reset timestamp. This fires even when no assistant error is
        // attached to a message, and it is provider-wide, so cool every slot on
        // that provider until the stated reset.
        if (event.type === "session.status") {
          const status = props.status as
            | { type?: string; message?: string; next?: number; action?: { reason?: string; provider?: string } }
            | undefined
          if (status?.type === "retry" && status.action?.reason === "free_tier_limit" && status.action.provider) {
            const provider = status.action.provider
            const until = typeof status.next === "number" && status.next > Date.now() ? status.next : Date.now() + HANG_FALLBACK_MS
            const cooled = pool.coolProvider(s, provider, until, "free_tier_limit")
            if (cooled.length > 0) {
              await log("warn", `free tier exhausted on provider ${provider}; cooling ${cooled.length} slot(s) until ${new Date(until).toISOString().slice(11, 19)}Z`, {
                provider,
                until,
                models: cooled.map((c) => c.model),
              })
            }
          }
          return
        }

        // Bind the subagent session opencode creates for a task call to the
        // claim that triggered it, oldest unbound claim first.
        if (event.type === "session.created") {
          const info = props.info as { id?: string; parentID?: string } | undefined
          if (info?.id && info.parentID) pool.bindChild(s, info.parentID, info.id)
          return
        }

        // Any message traffic means the task is alive. A hang is silence.
        if (event.type === "message.updated" || event.type === "message.part.updated") {
          const info = props.info as { sessionID?: string } | undefined
          const part = props.part as { sessionID?: string } | undefined
          const sessionID = info?.sessionID ?? part?.sessionID
          if (sessionID) pool.noteActivity(s, sessionID)
        }

        if (event.type !== "message.updated") return
        const info = props.info as { role?: string; error?: unknown; providerID?: string; modelID?: string } | undefined
        if (!info || info.role !== "assistant" || !info.error) return
        // Shape-agnostic: the error surfaces under different keys depending on
        // whether it came from the AI SDK or the gateway, so scan the whole
        // object rather than assuming data.message.
        const haystack = JSON.stringify(info.error) ?? ""
        const status = typeof (info.error as { data?: { statusCode?: number } }).data?.statusCode === "number"
          ? (info.error as { data: { statusCode: number } }).data.statusCode
          : undefined
        if (!pool.isLimitText(haystack) && status !== 429) return
        const model = `${info.providerID ?? "?"}/${info.modelID ?? "?"}`
        const stated = pool.statedCooldown(haystack) ?? pool.retryAfterMs((info.error as { data?: { responseHeaders?: Record<string, string> } }).data?.responseHeaders)
        const reason = haystack.match(/rate[\s_-]?limit|usage limit|too many requests|quota|freelimiterror|overloaded/i)?.[0]
          ?.toLowerCase()
          .replace(/[\s_]/g, "-")
        const strike = pool.recordStrike(s, model, reason ?? "rate-limited", stated)
        if (strike) await log("warn", `cooling ${model} for ${Math.round((strike.until - Date.now()) / 1000)}s (${reason ?? "rate-limited"}, strike ${strike.strikes})`)
      } catch (error) {
        await log("error", `limit detection failed: ${String(error)}`)
      }
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return
      try {
        const requested = output.args?.subagent_type
        if (typeof requested !== "string") return
        await reapStuck()
        pool.refreshCatalog(s, serverUrl)
        const snap = pool.snapshot(s)

        if (pool.BASES.includes(requested)) {
          const slot = pool.pickSlot(s, snap)
          const variant = pool.agentFor(requested, slot.index)
          if (s.known.size > 0 && !s.known.has(variant)) {
            await warnOnce(`variant ${variant} missing from config; spawn left unchanged`)
            return
          }
          pool.acquire(s, requested, slot, input.sessionID, pool.claimKey(input.sessionID, input.callID))
          output.args.subagent_type = variant
          await log("info", `routed ${requested} -> ${variant}`, {
            slot: slot.index,
            weight: slot.weight,
            model: slot.model,
            load: (snap.counts.get(slot.model) ?? 0) + 1,
            ratio: Number(pool.loadRatio(slot, snap.counts).toFixed(2)),
          })
          return
        }

        // A directly spawned variant is still counted, never rewritten.
        const direct = /^(.*)-([1-9][0-9]*)$/.exec(requested)
        if (direct && pool.BASES.includes(direct[1])) {
          const slot = s.slots.find((sl) => sl.index === Number(direct[2]))
          if (slot) pool.acquire(s, direct[1], slot, input.sessionID, pool.claimKey(input.sessionID, input.callID))
        }
      } catch (error) {
        await log("error", `routing failed, spawn unchanged: ${String(error)}`)
      }
    },

    "tool.execute.after": async (input) => {
      if (input.tool !== "task") return
      pool.release(s, pool.claimKey(input.sessionID, input.callID))
    },

    tool: {
      pool_status: tool({
        description:
          "Show live pool load across every opencode process, per free model and per agent type, each slot's weight and load ratio (lowest ratio wins, ties to the lighter slot, and the slot marked <- next is what the next spawn takes), and which models are cooling after a rate limit or a stuck task. Check it before launching many parallel subagents.",
        args: {},
        async execute() {
          pool.refreshCatalog(s, serverUrl)
          const slots = pool.ensureSlots(s, (m) => void warnOnce(m))
          const snap = pool.snapshot(s)
          const now = Date.now()
          const byModel = new Map<string, { total: number; bases: Map<string, number> }>()
          const add = (model: string, base: string) => {
            const entry = byModel.get(model) ?? { total: 0, bases: new Map() }
            entry.total++
            entry.bases.set(base, (entry.bases.get(base) ?? 0) + 1)
            byModel.set(model, entry)
          }
          for (const claim of snap.own.values()) add(claim.m, claim.v)
          for (const sibling of snap.siblings) for (const claim of sibling.claims) add(claim.m, claim.v)

          // Which slot the next pooled spawn would actually take, so a surprising routing
          // decision can be read off the status instead of guessed at from load alone.
          const next = pool.pickSlot(s, snap)
          const line = (slot: pool.Slot) => {
            const entry = byModel.get(slot.model)
            const users = entry && entry.bases.size > 0 ? [...entry.bases].map(([b, n]) => `${b}x${n}`).join(" ") : "idle"
            const strike = snap.cooling.get(slot.model)
            const status = s.catalog.get(slot.model)
            const notes = [
              strike ? `COOLING ${Math.ceil((strike.until - now) / 1000)}s (${strike.reason}, strike ${strike.strikes})` : "",
              status && status !== "active" && status !== "unknown" ? `catalog:${status}` : "",
            ].filter(Boolean)
            const marker = slot.index === next.index ? " <- next" : ""
            return `  slot ${slot.index} w${slot.weight}  ${slot.model}  load=${entry?.total ?? 0}  ratio=${pool.loadRatio(slot, snap.counts).toFixed(2)}${marker}  [${users}${notes.length ? "; " + notes.join("; ") : ""}]`
          }

          const total = [...snap.counts.values()].reduce((sum, n) => sum + n, 0)
          const coolingNow = [...snap.cooling.entries()].filter(([, st]) => st.until > now)
          const hung = [...snap.own.values()].filter((c) => now - c.t > pool.STUCK_MIN_AGE_MS && pool.idleFor(s, c, now) >= pool.STUCK_IDLE_MS).length

          return {
            title: `agent-pool: ${total} task(s) in flight, ${coolingNow.length} model(s) cooling`,
            output: [
              `shared pool over ${slots.length} free models from ${pool.MODELS_FILE}; bases: ${pool.BASES.join(", ")}\nlowest load ratio wins, ties to the lighter slot: ratio = (claims + ${pool.PRIORITY_MARGIN}) / weight`,
              ...slots.map(line),
              "",
              "by process:",
              `  ${s.id} (this process): ${snap.own.size} claim(s)`,
              ...snap.siblings.map((sibling) => `  ${sibling.id}: ${sibling.claims.length} claim(s)`),
              "",
              `${total} claim(s) in flight across ${snap.siblings.length + 1} process(es).`,
              `hung past ${Math.round(pool.STUCK_MIN_AGE_MS / 60000)}min with ${Math.round(pool.STUCK_IDLE_MS / 60000)}min silence: ${hung} (auto-aborted); reaped total: ${s.reaped}.`,
              `watchdog alive: last sweep ${s.lastSweep ? `${Math.max(0, Math.round((now - s.lastSweep) / 1000))}s ago` : "never"} (every ${Math.round(reapMs / 1000)}s).`,
              coolingNow.length === 0
                ? "no models cooling down."
                : `cooling: ${coolingNow.map(([m, st]) => `${m} for ${Math.ceil((st.until - now) / 1000)}s`).join(", ")}`,
            ].join("\n"),
          }
        },
      }),
    },

    dispose: async () => {
      clearInterval(timer)
      s.own.clear()
    },
  }
}) satisfies Plugin