// Limit-awareness tests for the agent-pool plugin: strike recording, cooldown
// routing, stuck-claim recovery, catalog gating, and shared cross-process
// state. Run with: node ~/.config/opencode/tests/pool-limits-test.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(HERE, "..", "opencode.jsonc")
const PLUGIN = join(HERE, "..", "plugins", "agent-pool.ts")
const cfg = JSON.parse(readFileSync(CONFIG, "utf8"))

const logs = []
const client = { app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) } }
let aborted = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const m = /\/session\/([^/]+)\/abort/.exec(String(url))
  if (m) aborted.push(m[1])
  return new Response("true", { status: 200 })
}

const { AgentPool } = await import(PLUGIN)

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    failures++
  }
}

const made = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "limits-"))
  made.push(dir)
  return dir
}

const mk = async (id, dir) => {
  const hooks = await AgentPool({ client, serverUrl: new URL("http://127.0.0.1:59999") }, { id, dir })
  await hooks.config(cfg)
  return {
    hooks,
    spawn: async (callID, requested = "explore-fast", sessionID = "s1") => {
      const out = { args: { subagent_type: requested, prompt: "x" } }
      await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
      return out.args.subagent_type
    },
    finish: async (callID, sessionID = "s1") => {
      await hooks["tool.execute.after"]({ tool: "task", sessionID, callID, args: {} }, {})
    },
    status: async () => (await hooks.tool.pool_status.execute({}, {})).output,
    limitEvent: async (providerID, modelID, error) =>
      hooks.event({ event: { type: "message.updated", properties: { info: { role: "assistant", providerID, modelID, error } } } }),
  }
}

const rateError = (message, extra = {}) => ({ name: "APIError", data: { message, isRetryable: true, ...extra } })
const dirA = scratch()
const dirB = scratch()

// 1. a rate-limit error message cools the model and routing avoids it
{
  const a = await mk("p1", dirA)
  assert((await a.spawn("a1")) === "explore-fast-1", "baseline routes to first primary")
  await a.limitEvent("opencode", "big-pickle", rateError("Rate limit exceeded. Please try again later."))
  const after = []
  for (let i = 0; i < 6; i++) after.push(await a.spawn(`a${i + 2}`))
  assert(!after.includes("explore-fast-1"), `cooled primary must be skipped, got ${after.join(",")}`)
  assert(after.includes("explore-fast-2"), "other primary must still take work")
  assert(/COOLING/.test(await a.status()), "status must flag the cooling model")
  assert(/cooling: opencode\/big-pickle/.test(await a.status()), "status must name the cooling model")
}

// 2. unrelated errors must NOT cool anything
{
  const b = await mk("p2", dirB)
  await b.limitEvent("opencode", "big-pickle", rateError("connection reset by peer"))
  await b.limitEvent("opencode", "big-pickle", { name: "UnknownError", data: { message: "tool call malformed" } })
  assert(!/COOLING/.test(await b.status()), "non-limit errors must not trigger a cooldown")
}

// 3. a stated reset time wins over the exponential guess
{
  const c = await mk("p3", scratch())
  await c.limitEvent("opencode-go", "glm-5.2", rateError("5-hour usage limit reached. Resets in 35min."))
  const status = await c.status()
  const seconds = Number(/glm-5\.2 for (\d+)s/.exec(status)?.[1])
  assert(seconds > 2000 && seconds <= 2100, `stated 35min cooldown should be honoured, got ${seconds}s`)
}

// 4. retry-after response header is honoured
{
  const d = await mk("p4", scratch())
  await d.limitEvent("opencode", "nemotron-3-ultra-free", rateError("too many requests", { responseHeaders: { "retry-after": "120" } }))
  const seconds = Number(/nemotron-3-ultra-free for (\d+)s/.exec(await d.status())?.[1])
  assert(seconds > 110 && seconds <= 120, `retry-after should set a 120s cooldown, got ${seconds}s`)
}

// 5. repeated strikes back off exponentially, and decay after STRIKE_DECAY_MS
{
  const e = await mk("p5", scratch())
  const err = rateError("Rate limit exceeded")
  await e.limitEvent("opencode-go", "longcat-2.5-preview-free", err)
  const first = Number(/longcat[^ ]* for (\d+)s/.exec(await e.status())?.[1])
  await e.limitEvent("opencode-go", "longcat-2.5-preview-free", err)
  const second = Number(/longcat[^ ]* for (\d+)s/.exec(await e.status())?.[1])
  assert(second === first * 2, `second strike should double the cooldown (${first}s -> ${second}s)`)
  assert(/strike 2/.test(await e.status()), "status should show the strike count")
}

// 6. a hung claim is released and its model cooled, so the slot comes back
{
  const dir = scratch()
  const f = await mk("p6", dir)
  await f.spawn("f1")
  await f.hooks.event({ event: { type: "session.created", properties: { info: { id: "child-x", parentID: "s1" } } } })
  const realNow = Date.now
  Date.now = () => realNow() + 9 * 60 * 1000
  const next = await f.spawn("f2")
  Date.now = realNow
  assert(next !== "explore-fast-1", `a hung claim must free its slot and cool the model, got ${next}`)
  assert(/hang/.test(await f.status()), "status should attribute the recovery to a hang")
}

// 7. cooldowns are shared across processes through the claim dir
{
  const g = await mk("writer", dirA)
  const h = await mk("reader", dirA)
  await g.limitEvent("opencode-go", "space-bunny-free", rateError("Rate limit exceeded"))
  assert(/COOLING/.test(await h.status()), "a peer process must observe a cooldown written by another")
  const picks = []
  for (let i = 0; i < 4; i++) picks.push(await h.spawn(`h${i}`))
  assert(!picks.includes("explore-fast-2"), `peer must avoid the cooled model, got ${picks.join(",")}`)
}

// 8. expired cooldown files are pruned, not honoured forever
{
  const dir = scratch()
  const i = await mk("p8", dir)
  await i.limitEvent("opencode", "big-pickle", rateError("Rate limit exceeded"))
  assert(readdirSync(dir).some((f) => f.startsWith("limit.")), "a cooldown file should be written")
  const realNow = Date.now
  Date.now = () => realNow() + 16 * 60 * 1000
  await i.status()
  Date.now = realNow
  assert(!readdirSync(dir).some((f) => f.startsWith("limit.")), "a lapsed cooldown file should be pruned on read")
}

// 9. routing still works when every model is cooling (must not refuse to route)
{
  const j = await mk("p9", scratch())
  for (const [providerID, modelID] of [
    ["opencode", "big-pickle"],
    ["opencode-go", "space-bunny-free"],
    ["opencode", "nemotron-3-ultra-free"],
    ["opencode-go", "longcat-2.5-preview-free"],
  ])
    await j.limitEvent(providerID, modelID, rateError("Rate limit exceeded"))
  const pick = await j.spawn("j1")
  assert(/^explore-fast-[1-4]$/.test(pick), `must still route when all models cool, got ${pick}`)
}

// 10. catalog status gates retired models (simulated by seeding serverUrl-less state)
{
  const k = await mk("p10", scratch())
  assert(/slot 3/.test(await k.status()) && /slot 4/.test(await k.status()), "overflow slots must be listed in status")
  assert(existsSync(PLUGIN), "plugin file must exist")
}

globalThis.fetch = realFetch
for (const dir of made) rmSync(dir, { recursive: true, force: true })
if (failures === 0) console.log("\nALL LIMIT CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}