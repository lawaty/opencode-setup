import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Resolved relative to this file so the suite survives a /tmp clean and can
// live anywhere inside the config tree.
const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(HERE, "..", "opencode.jsonc")
const PLUGIN = join(HERE, "..", "plugins", "agent-pool.ts")
const SNAPSHOT = join(HERE, "models-snapshot.json")
const cfg = JSON.parse(readFileSync(CONFIG, "utf8"))

const logs = []
const client = { app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) } }
const { AgentPool } = await import(PLUGIN)

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    process.exit(1)
  }
}

const make = async (id, dir) => {
  const hooks = await AgentPool({ client }, { id, dir })
  await hooks.config(cfg)
  const spawn = async (callID, requested, sessionID = "s1") => {
    const out = { args: { subagent_type: requested, prompt: "x" } }
    await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
    return out.args.subagent_type
  }
  const finish = async (callID, sessionID = "s1") => {
    await hooks["tool.execute.after"]({ tool: "task", sessionID, callID, args: {} }, {})
  }
  const status = async () => (await hooks.tool.pool_status.execute({}, {})).output
  return { hooks, spawn, finish, status }
}

const dir1 = mkdtempSync(join(tmpdir(), "agent-pool-solo-"))
const seq = (calls) => calls.map((c) => c.replace(/^[a-z-]+-/, "")).join(",")

// 1. routing: exact cycle 1,2,3,4 from spawn 3 on; 2/2/1/1 at 6; 4/4/2/2 at 12
const a = await make("solo", dir1)
const calls = []
for (let i = 1; i <= 12; i++) {
  calls.push(await a.spawn(`c${i}`, "explore-fast"))
  if (i === 6) assert(seq(calls) === "1,2,1,2,3,4", `6 concurrent should be 1,2,1,2,3,4, got ${seq(calls)}`)
}
assert(seq(calls) === "1,2,1,2,3,4,1,2,3,4,1,2", `12 concurrent sequence wrong: ${seq(calls)}`)

// 2. releasing a primary claim returns routing to the primary tier
await a.finish("c3")
assert((await a.spawn("r1", "explore-fast")) === "explore-fast-1", "freed primary slot should be reused")

// 3. releasing an overflow claim refills overflow; primaries retake only once
//    the least primary is no longer TIER_MARGIN ahead. Traced: 3,3,4,1
await a.finish("c5")
const back = [await a.spawn("r2", "explore-fast"), await a.spawn("r3", "explore-fast"), await a.spawn("r4", "explore-fast"), await a.spawn("r5", "explore-fast")]
assert(seq(back) === "3,3,4,1", `overflow should drain before primaries retake, got ${seq(back)}`)

// 4. pool_status reports global load, models, tiers, per-process breakdown
const statusOut = await a.status()
assert(statusOut.includes("opencode/big-pickle") && statusOut.includes("opencode-go/space-bunny-free"), "status should show both primary models")
assert(statusOut.includes("nemotron-3-ultra-free") && statusOut.includes("longcat-2.5-preview-free"), "status should show both overflow models")
assert(/slot 1 primary/.test(statusOut) && /slot 3 overflow/.test(statusOut), "status should label tiers")
assert(/across 1 process\(es\)/.test(statusOut), "solo process should report one process")

// 5. cross-process sharing: both processes MUST share one claim dir
const dir3 = mkdtempSync(join(tmpdir(), "agent-pool-share-"))
const x = await make("proc-x", dir3)
const y = await make("proc-y", dir3)
const xCalls = []
for (let i = 1; i <= 6; i++) xCalls.push(await x.spawn(`x${i}`, "explore-fast"))
assert(seq(xCalls) === "1,2,1,2,3,4", `first process should reach 2/2/1/1, got ${seq(xCalls)}`)
const yCalls = []
for (let i = 1; i <= 6; i++) yCalls.push(await y.spawn(`y${i}`, "explore-fast"))
assert(seq(yCalls) === "1,2,3,4,1,2", `second process must continue the shared cycle, got ${seq(yCalls)}`)
const crossStatus = await x.status()
const loadOf = (model) => {
  const line = crossStatus.split("\n").find((l) => l.includes(model))
  return line ? Number(/load=(\d+)/.exec(line)[1]) : NaN
}
assert(loadOf("opencode/big-pickle") === 4 && loadOf("opencode-go/space-bunny-free") === 4, `shared primaries wrong: 1->${loadOf("opencode/big-pickle")} 2->${loadOf("opencode-go/space-bunny-free")}`)
assert(loadOf("opencode/nemotron-3-ultra-free") === 2 && loadOf("opencode-go/longcat-2.5-preview-free") === 2, `shared overflow wrong: 3->${loadOf("opencode/nemotron-3-ultra-free")} 4->${loadOf("opencode-go/longcat-2.5-preview-free")}`)
assert(/across 2 process\(es\)/.test(crossStatus), "status should count both processes")
assert(/proc-x \(this process\): 6 claim\(s\)/.test(crossStatus) && /proc-y: 6 claim\(s\)/.test(crossStatus), "status should break load down per process")
await x.finish("x1")
assert(/proc-x \(this process\): 5 claim\(s\)/.test(await x.status()), "release in one process must be visible to itself")
assert(/proc-x: 5 claim\(s\)/.test(await y.status()), "release in one process must be visible to the other process")
assert(/proc-y \(this process\): 6 claim\(s\)/.test(await y.status()), "a peer release must not disturb this process's own count")

// 6. degraded mode: unusable claim dir must not break routing
const blocked = join(dir1, "not-a-dir")
writeFileSync(blocked, "x")
const c = await make("degraded", blocked)
const degradedPick = await c.spawn("d1", "explore-fast")
assert(degradedPick === "explore-fast-1" || degradedPick === "explore-fast-2", `degraded mode should still route, got ${degradedPick}`)
assert(logs.some((l) => l.startsWith("warn") && l.includes("claim dir")), "degraded mode should warn once")

// 7. stale claim files and orphan tmp files are pruned
const stale = join(dir3, "claims.99999.json")
const orphan = join(dir3, "claims.99998.json.tmp")
writeFileSync(stale, JSON.stringify({ k: { v: "explore-fast-1", t: Date.now() } }))
writeFileSync(orphan, "{}")
const old = Date.now() / 1000 - 3600
utimesSync(stale, old, old)
utimesSync(orphan, old, old)
await x.spawn("x2", "explore-fast")
assert(!existsSync(stale), "stale claim file should be pruned")
assert(!existsSync(orphan), "orphan tmp file should be pruned")

// 8. TTL: claims older than 10 min stop counting
const realNow = Date.now
Date.now = () => realNow() + 11 * 60 * 1000
const afterTtl = await a.spawn("t1", "explore-fast")
Date.now = realNow
assert(afterTtl === "explore-fast-1", `TTL should empty the pool, got ${afterTtl}`)

// 9. untouched: non-task tool, non-pool spawn, direct variant, malformed args
const other = { args: { filePath: "/etc" } }
await a.hooks["tool.execute.before"]({ tool: "read", sessionID: "s1", callID: "x1" }, other)
assert(other.args.filePath === "/etc", "non-task tool must not be touched")
assert((await a.spawn("x2", "explore-deep")) === "explore-deep", "non-pool spawn must not be rewritten")
assert((await a.spawn("x3", "explore-fast-2")) === "explore-fast-2", "direct variant must not be rewritten")
await a.hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "x5" }, {})
await a.finish("nonexistent")

// 10. config invariants: every pooled base has 4 hidden variants, one per slot
const BASES = ["explore-fast", "implement-fast", "context-manager"]
const SLOT_MODELS = [
  "opencode/big-pickle",
  "opencode-go/space-bunny-free",
  "opencode/nemotron-3-ultra-free",
  "opencode-go/longcat-2.5-preview-free",
]
for (const base of BASES) {
  assert(cfg.agent[base], `base agent ${base} must exist`)
  SLOT_MODELS.forEach((model, i) => {
    const v = `${base}-${i + 1}`
    assert(cfg.agent[v], `${v} must exist`)
    assert(cfg.agent[v].model === model, `${v} should run ${model}, got ${cfg.agent[v].model}`)
    assert(cfg.agent[v].hidden === true, `${v} should stay hidden`)
    assert(cfg.agent[v].prompt === cfg.agent[base].prompt, `${v} should reuse the ${base} prompt`)
  })
}
// slot N means the same model for every base, which is what makes load shared
for (let i = 0; i < SLOT_MODELS.length; i++) {
  const models = BASES.map((b) => cfg.agent[`${b}-${i + 1}`].model)
  assert(new Set(models).size === 1, `slot ${i + 1} must map to one model across bases, got ${models}`)
}
for (const model of SLOT_MODELS) {
  const [provider, id] = model.split("/")
  assert(cfg.provider[provider].whitelist.includes(id), `${model} must be whitelisted on ${provider}`)
}
for (const [name, def] of Object.entries(cfg.agent)) {
  if (!def.model) continue
  const [provider, id] = def.model.split("/")
  assert(cfg.provider[provider]?.whitelist.includes(id), `agent ${name} runs unwhitelisted ${def.model}`)
}
// any agent allowed to spawn a base must be allowed to spawn all its variants
for (const [name, def] of Object.entries(cfg.agent)) {
  const task = def.permission?.task
  if (!task) continue
  for (const base of BASES) {
    if (task[base] !== "allow") continue
    for (let i = 1; i <= SLOT_MODELS.length; i++) {
      assert(task[`${base}-${i}`] === "allow", `${name} allows ${base} so it must allow ${base}-${i}`)
    }
  }
}

// 11. all four pool models are free (0/0 cost) per the vendored models.dev
//     snapshot, which is refreshed with: curl -sS https://models.dev/api.json
assert(existsSync(SNAPSHOT), `missing ${SNAPSHOT}; re-fetch models.dev to rebuild it`)
const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"))
for (const model of SLOT_MODELS) {
  const entry = snapshot.models[model]
  assert(entry, `snapshot has no ${model} (stale: re-fetch models.dev)`)
  assert(entry.cost_input === 0 && entry.cost_output === 0, `${model} must be free, snapshot says ${entry.cost_input}/${entry.cost_output}`)
  assert(entry.tool_call === true, `${model} must support tool calls to be usable as an explore agent`)
}

console.log(statusOut)
rmSync(dir1, { recursive: true, force: true })
rmSync(dir3, { recursive: true, force: true })
console.log("\nALL CHECKS PASSED")