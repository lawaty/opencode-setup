import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Shared model pool for every free-model agent type.
//
// One set of slots is shared by ALL pooled agent types (explore-fast,
// implement-fast, context-manager). A slot is a model, not an agent: load is
// counted per MODEL across every agent type, so total pressure on each model is
// balanced no matter which kind of work is running. Slot N of any base is the
// same model, so `explore-fast-2` and `context-manager-2` are the same model and
// share one load counter.
//
// This module holds the state and the decision; plugins/agent-pool.ts owns the
// hooks (task routing, limit detection, hang reaping) and
// plugins/context-autoupdate.ts borrows a slot directly, because it spawns its
// agent through the session API rather than the task tool and so never passes
// through the task hook.
//
// Which models fill the slots comes from pool-models.json (see readSlotFile),
// resolved once per process into State.slots and shared by both plugins.

export const CLAIM_TTL_MS = 10 * 60 * 1000
export const DEAD_FILE_MS = 2 * CLAIM_TTL_MS
export const ORPHAN_TMP_MS = 60 * 1000
export const TIER_MARGIN = 2
export const CATALOG_TTL_MS = 10 * 60 * 1000
export const STUCK_MIN_AGE_MS = 5 * 60 * 1000
export const STUCK_IDLE_MS = 3 * 60 * 1000
export const HANG_COOLDOWN_MS = 10 * 60 * 1000
const COOLDOWN_BASE_MS = 60 * 1000
const COOLDOWN_MAX_MS = 15 * 60 * 1000
const STRIKE_DECAY_MS = 30 * 60 * 1000

export type Tier = "primary" | "overflow"
export type Slot = { index: number; model: string; tier: Tier }
export type Claim = { v: string; k: number; m: string; t: number; s?: string; g?: string }
export type Strike = { model: string; until: number; strikes: number; reason: string; last: number }
export type Sibling = { id: string; claims: Claim[] }
export type Snapshot = {
  counts: Map<string, number>
  cooling: Map<string, Strike>
  siblings: Sibling[]
  own: Map<string, Claim>
  dirReady: boolean
}

export const BASES = ["explore-fast", "implement-fast", "context-manager"]

// The pool is configured by ONE hand-edited file, pool-models.json, next to
// opencode.jsonc. The variant agents in opencode.jsonc (explore-fast-1 ...)
// are rewritten from it at config time by plugins/agent-pool.ts, so swapping a
// model means editing this file, never a dozen agent definitions. The values
// below are the fallback used only when the file is missing or unusable, so a
// typo degrades to a logged warning instead of a pool that cannot route.
export const MODELS_FILE = "pool-models.json"
export const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")
export const MODELS_PATH = join(CONFIG_DIR, MODELS_FILE)

export const FALLBACK_SLOTS: Slot[] = [
  { index: 1, model: "opencode/big-pickle", tier: "primary" },
  { index: 2, model: "opencode-go/space-bunny-free", tier: "primary" },
  { index: 3, model: "opencode/nemotron-3-ultra-free", tier: "overflow" },
  { index: 4, model: "opencode-go/longcat-2.5-preview-free", tier: "overflow" },
]

export type SlotFile = { slots: Slot[]; problems: string[] }

// Slot indices are the array position, so the file is the only place a slot
// number exists; nothing downstream can disagree with it. Every entry is
// validated on its own: one bad slot is dropped with a warning, the rest still
// route, unless nothing survives and the built-in defaults take over.
export function readSlotFile(path: string = MODELS_PATH): SlotFile {
  const problems: string[] = []
  let parsed: { slots?: unknown }
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { slots?: unknown }
  } catch (error) {
    return { slots: FALLBACK_SLOTS, problems: [`${path} unreadable (${String(error)}); using built-in defaults`] }
  }
  if (!Array.isArray(parsed.slots) || parsed.slots.length === 0) {
    return { slots: FALLBACK_SLOTS, problems: [`${path} has no non-empty "slots" array; using built-in defaults`] }
  }
  const slots: Slot[] = []
  parsed.slots.forEach((entry, i) => {
    const model = typeof (entry as { model?: unknown })?.model === "string" ? ((entry as { model: string }).model).trim() : ""
    const raw = (entry as { tier?: unknown })?.tier
    const tier = raw === "primary" || raw === "overflow" ? raw : undefined
    const at = `slot ${i + 1}`
    if (!model.includes("/")) return problems.push(`${at}: model must be written provider/model-id, got "${model}"`)
    if (!tier) return problems.push(`${at} (${model}): tier must be "primary" or "overflow", got ${JSON.stringify(raw)}`)
    if (slots.some((s) => s.model === model)) return problems.push(`${at}: ${model} is already used by another slot; slots must be distinct models`)
    slots.push({ index: slots.length + 1, model, tier })
  })
  if (slots.length === 0) {
    problems.push(`${path} yielded no usable slot; using built-in defaults`)
    return { slots: FALLBACK_SLOTS, problems }
  }
  return { slots, problems }
}

const LIMIT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /usage limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota/i,
  /freelimiterror/i,
  /overloaded/i,
]

export const isLimitText = (text: string) => LIMIT_PATTERNS.some((re) => re.test(text))

// Providers sometimes state exactly when the window reopens; prefer that over a
// guessed backoff. Handles "Resets in 35min", "Resets in 2hr 17min", "retry in 90s".
export const statedCooldown = (text: string): number | undefined => {
  const hm = /resets?\s+in\s+(\d+)\s*(?:h|hr|hour)s?\s*(\d+)?\s*(?:m|min|minute)?s?/i.exec(text)
  if (hm) return (Number(hm[1]) * 60 + (hm[2] ? Number(hm[2]) : 0)) * 60 * 1000
  const m = /resets?\s+in\s+(\d+)\s*(?:m|min|minute)s?/i.exec(text)
  if (m) return Number(m[1]) * 60 * 1000
  const s = /retry[\s-]?in\s+(\d+)\s*(?:s|sec|second)s?/i.exec(text)
  if (s) return Number(s[1]) * 1000
  return undefined
}

export const retryAfterMs = (headers?: Record<string, string>): number | undefined => {
  if (!headers) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "retry-after") continue
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, COOLDOWN_MAX_MS)
    const when = Date.parse(value)
    if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 1000), COOLDOWN_MAX_MS)
  }
  return undefined
}

type State = {
  own: Map<string, Claim>
  models: Map<string, string>
  known: Set<string>
  warned: Set<string>
  initialized: boolean
  dirReady: boolean
  catalog: Map<string, string>
  catalogAt: number
  cooling: Map<string, Strike>
  activity: Map<string, number>
  reaped: number
  reaping: boolean
  lastSweep: number
  id: string
  dir: string
  modelsFile: string
  slots: Slot[]
}

export function state(opts: { id?: string; dir?: string; modelsFile?: string } = {}): State {
  const id = opts.id ?? String(process.pid)
  const dir = opts.dir ?? join(homedir(), ".local", "share", "opencode", "agent-pool")
  const modelsFile = opts.modelsFile ?? MODELS_PATH
  // Keyed by identity so the pool plugin and context-autoupdate share one state
  // in a process (same pid + dir), while separate ids stay independent.
  const key = Symbol.for(`agent-pool:state:${id}:${dir}:${modelsFile}`)
  const g = globalThis as Record<symbol, State | undefined>
  if (!g[key]) {
    g[key] = {
      own: new Map(),
      models: new Map(),
      known: new Set(),
      warned: new Set(),
      initialized: false,
      dirReady: false,
      catalog: new Map(),
      catalogAt: 0,
      cooling: new Map(),
      activity: new Map(),
      reaped: 0,
      reaping: false,
      lastSweep: 0,
      id,
      dir,
      modelsFile,
      slots: [],
    }
  }
  return g[key]
}

// Read once per process, on first use: plugins are not hot-reloaded, so editing
// pool-models.json means restarting opencode anyway.
export function ensureSlots(s: State, onWarn: (m: string) => void) {
  if (s.slots.length > 0) return s.slots
  const { slots, problems } = readSlotFile(s.modelsFile)
  s.slots = slots
  for (const problem of problems) onWarn(problem)
  return slots
}

export const claimKey = (sessionID: string, callID: string) => `${sessionID}:${callID}`
export const selfFile = (id: string) => `claims.${id}.json`
const limitFile = (model: string) => `limit.${model.replace(/[^a-zA-Z0-9._-]/g, "__")}.json`

export function init(s: State, onWarn: (m: string) => void) {
  ensureSlots(s, onWarn)
  if (s.initialized) return
  s.initialized = true
  try {
    mkdirSync(s.dir, { recursive: true })
    s.dirReady = true
    try { unlinkSync(join(s.dir, selfFile(s.id))) } catch {} // dead process with a recycled id
  } catch {
    onWarn(`claim dir ${s.dir} unusable; pool load tracked in memory only`)
  }
}

export function pruneOwn(s: State) {
  const now = Date.now()
  for (const [key, claim] of s.own) if (now - claim.t > CLAIM_TTL_MS) s.own.delete(key)
}

export function publish(s: State) {
  if (!s.dirReady) return
  const now = Date.now()
  const payload: Record<string, Claim> = {}
  for (const [key, claim] of s.own) if (now - claim.t <= CLAIM_TTL_MS) payload[key] = claim
  try {
    writeFileSync(join(s.dir, `${selfFile(s.id)}.tmp`), JSON.stringify(payload))
    renameSync(join(s.dir, `${selfFile(s.id)}.tmp`), join(s.dir, selfFile(s.id)))
  } catch {
    s.dirReady = false
  }
}

export function readSiblings(s: State): Sibling[] {
  const siblings: Sibling[] = []
  let entries: string[]
  try {
    entries = readdirSync(s.dir)
  } catch {
    return siblings
  }
  const now = Date.now()
  for (const entry of entries) {
    const path = join(s.dir, entry)
    let age: number
    try {
      age = now - statSync(path).mtimeMs
    } catch {
      continue
    }
    if (entry.endsWith(".tmp")) {
      if (age > ORPHAN_TMP_MS) try { unlinkSync(path) } catch {}
      continue
    }
    const match = /^claims\.(.+)\.json$/.exec(entry)
    if (!match || match[1] === s.id) continue
    if (age > DEAD_FILE_MS) {
      try { unlinkSync(path) } catch {}
      continue
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, Claim>
      const claims = Object.values(parsed).filter(
        (c) => c && typeof c.v === "string" && typeof c.m === "string" && now - c.t <= CLAIM_TTL_MS,
      )
      siblings.push({ id: match[1], claims })
    } catch {
      // a sibling that vanished or is unreadable is skipped, never fatal
    }
  }
  return siblings
}

export function readLimits(s: State): Map<string, Strike> {
  const cooling = new Map<string, Strike>()
  let entries: string[]
  try {
    entries = readdirSync(s.dir)
  } catch {
    return cooling
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.startsWith("limit.") || !entry.endsWith(".json")) continue
    const path = join(s.dir, entry)
    try {
      const strike = JSON.parse(readFileSync(path, "utf8")) as Strike
      if (typeof strike.until !== "number" || typeof strike.model !== "string") continue
      if (strike.until > now) cooling.set(strike.model, strike)
      else unlinkSync(path)
    } catch {
      try { unlinkSync(path) } catch {}
    }
  }
  s.cooling = cooling
  return cooling
}

export function recordStrike(s: State, model: string, reason: string, stated?: number) {
  if (!s.dirReady) return
  const now = Date.now()
  const prior = s.cooling.get(model)
  const strikes = prior && now - prior.last < STRIKE_DECAY_MS ? prior.strikes + 1 : 1
  const backoff = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (strikes - 1))
  const strike: Strike = { model, until: now + (stated ?? backoff), strikes, reason, last: now }
  s.cooling.set(model, strike)
  const path = join(s.dir, limitFile(model))
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(strike))
    renameSync(`${path}.tmp`, path)
  } catch {
    /* cooldown stays local to this process */
  }
  return strike
}

export function refreshCatalog(s: State, serverUrl?: URL) {
  if (!serverUrl || Date.now() - s.catalogAt < CATALOG_TTL_MS) return
  s.catalogAt = Date.now()
  void (async () => {
    try {
      const response = await fetch(new URL("/api/model", serverUrl).toString())
      if (!response.ok) return
      const payload = (await response.json()) as { data?: { id: string; providerID: string; status?: string }[] }
      const catalog = new Map<string, string>()
      for (const m of payload.data ?? []) catalog.set(`${m.providerID}/${m.id}`, m.status ?? "unknown")
      if (catalog.size > 0) s.catalog = catalog
    } catch {
      // advisory only
    }
  })()
}

export function isAvailable(s: State, model: string, cooling: Map<string, Strike>) {
  if (cooling.has(model)) return false
  const status = s.catalog.get(model)
  return status === undefined || status === "active" || status === "unknown"
}

export function snapshot(s: State): Snapshot {
  pruneOwn(s)
  const siblings = readSiblings(s)
  const cooling = readLimits(s)
  const counts = new Map<string, number>()
  const bump = (m: string) => counts.set(m, (counts.get(m) ?? 0) + 1)
  for (const claim of s.own.values()) bump(claim.m)
  for (const sibling of siblings) for (const claim of sibling.claims) bump(claim.m)
  return { counts, cooling, siblings, own: s.own, dirReady: s.dirReady }
}

const loadOf = (counts: Map<string, number>, model: string) => counts.get(model) ?? 0

function leastLoaded(slots: Slot[], counts: Map<string, number>) {
  return slots.reduce((best, slot) => (loadOf(counts, slot.model) < loadOf(counts, best.model) ? slot : best), slots[0])
}

// Primary slots stay load-equalized and keep a TIER_MARGIN lead over the
// least-loaded overflow slot; from the third acquire onward the sequence is
// exactly the 1,2,3,4 cycle.
export function pickSlot(s: State, snap: Snapshot): Slot {
  const slots = s.slots.length > 0 ? s.slots : FALLBACK_SLOTS
  const usable = slots.filter((slot) => isAvailable(s, slot.model, snap.cooling))
  const pool = usable.length > 0 ? usable : slots
  const primaries = pool.filter((slot) => slot.tier === "primary")
  const overflow = pool.filter((slot) => slot.tier === "overflow")
  if (primaries.length === 0) return leastLoaded(overflow.length ? overflow : pool, snap.counts)
  if (overflow.length === 0) return leastLoaded(primaries, snap.counts)
  const lp = leastLoaded(primaries, snap.counts)
  const lo = leastLoaded(overflow, snap.counts)
  return loadOf(snap.counts, lp.model) >= loadOf(snap.counts, lo.model) + TIER_MARGIN ? lo : lp
}

export function agentFor(base: string, slot: number) {
  return `${base}-${slot}`
}

// Records an in-flight claim. `target` is the session that actually runs the
// work: for a task spawn it is the child session (bound later), for a
// plugin-spawned session it is the session itself.
export function acquire(s: State, base: string, slot: Slot, ownerSession: string, key: string, target?: string) {
  s.own.set(key, { v: base, k: slot.index, m: slot.model, t: Date.now(), s: ownerSession, g: target })
  if (target) s.activity.set(target, Date.now())
  publish(s)
}

export function release(s: State, key: string) {
  if (s.own.delete(key)) publish(s)
}

export function bindChild(s: State, parentID: string, childID: string) {
  const candidates = [...s.own.entries()]
    .filter(([, c]) => c.s === parentID && !c.g)
    .sort((a, b) => a[1].t - b[1].t)
  if (candidates.length === 0) return false
  candidates[0][1].g = childID
  s.activity.set(childID, Date.now())
  publish(s)
  return true
}

export function noteActivity(s: State, sessionID: string) {
  s.activity.set(sessionID, Date.now())
}

export function idleFor(s: State, claim: Claim, now: number) {
  const target = claim.g
  if (!target) return Infinity
  const seen = s.activity.get(target)
  return seen ? now - seen : Infinity
}

// A usage limit hangs instead of failing, so nothing releases the claim and the
// caller never regains control. An aged claim whose target has gone silent is
// presumed wedged.
export function findStuck(s: State, now = Date.now()) {
  const stuck: { key: string; claim: Claim }[] = []
  for (const [key, claim] of s.own) {
    if (now - claim.t <= STUCK_MIN_AGE_MS) continue
    if (idleFor(s, claim, now) < STUCK_IDLE_MS) continue
    stuck.push({ key, claim })
  }
  return stuck
}

export function releaseStuck(s: State, keys: string[]) {
  for (const key of keys) s.own.delete(key)
  if (keys.length > 0) publish(s)
}

export function slotFor(s: State, model: string) {
  return s.slots.find((slot) => slot.model === model)
}

export const providerOf = (model: string) => model.split("/")[0] ?? model

// opencode itself reports free-tier exhaustion per session as
// status.type "retry" with action.reason "free_tier_limit", the provider, and
// a `next` timestamp. That is a provider-wide signal, so every slot on that
// provider is cooled until the stated reset rather than one model at a time.
export function coolProvider(s: State, provider: string, until: number, reason: string) {
  const affected: Strike[] = []
  for (const slot of s.slots.length > 0 ? s.slots : FALLBACK_SLOTS) {
    if (providerOf(slot.model) !== provider) continue
    const existing = s.cooling.get(slot.model)
    const untilMs = Math.max(until, existing?.until ?? 0)
    const strike = recordStrike(s, slot.model, reason, untilMs - Date.now())
    if (strike) affected.push(strike)
  }
  return affected
}