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

// pool-models.json is the single source of truth for the pool, so the test reads
// it rather than repeating the models: swapping one is not a test edit.
const SHIPPED = JSON.parse(readFileSync(join(HERE, "..", "pool-models.json"), "utf8")).slots
const SLOT_MODELS = SHIPPED.map((s) => s.model)
const PRIMARY_MODELS = SHIPPED.filter((s) => s.tier === "primary").map((s) => s.model)
const OVERFLOW_MODELS = SHIPPED.filter((s) => s.tier === "overflow").map((s) => s.model)

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

// 1. routing: primaries are filled evenly before overflow engages. The exact
//    interleave depends on slot count and TIER_MARGIN, so what is pinned here is
//    the property, not a literal sequence -- slot numbers and tier order are
//    pool-models.json's business.
const a = await make("solo", dir1)
const calls = []
for (let i = 1; i <= 12; i++) calls.push(await a.spawn(`c${i}`, "explore-fast"))
const slotNum = (variant) => Number(/-(\d+)$/.exec(variant)[1])
const numbers = calls.map(slotNum)
assert(
  numbers.every((n) => n >= 1 && n <= SLOT_MODELS.length),
  `every spawn must land on a declared slot, got ${seq(calls)}`,
)
assert(
  new Set(numbers).size === SLOT_MODELS.length,
  `all ${SLOT_MODELS.length} slots must be used under 12 concurrent, got ${seq(calls)}`,
)
// each tier is filled evenly before the next tier is touched
const primaryPicks = numbers.slice(0, 2 * PRIMARY_MODELS.length)
assert(
  primaryPicks.every((n) => PRIMARY_MODELS.includes(SLOT_MODELS[n - 1])),
  `the first ${2 * PRIMARY_MODELS.length} spawns must be primaries, got ${seq(calls)}`,
)
const countsByModel = (ns) => {
  const m = new Map()
  for (const n of ns) m.set(SLOT_MODELS[n - 1], (m.get(SLOT_MODELS[n - 1]) ?? 0) + 1)
  return m
}
for (const model of PRIMARY_MODELS) {
  assert(countsByModel(primaryPicks).get(model) === 2, `${model} should be loaded twice before overflow, got ${seq(calls)}`)
}

// 2. releasing a claim returns routing to the freed slot's tier, since that slot
//    is the least loaded again. Read the tier off the released claim rather than
//    assuming slot 3 happens to be an overflow slot.
const freedSlot = slotNum(calls[2]) // the slot c3 claimed
const freedTier = SHIPPED[freedSlot - 1].tier
await a.finish("c3")
const afterRelease = slotNum(await a.spawn("r1", "explore-fast"))
assert(
  SHIPPED[afterRelease - 1].tier === freedTier,
  `a freed ${freedTier} claim should return routing to the ${freedTier} tier, got slot ${afterRelease} (${SHIPPED[afterRelease - 1].tier})`,
)

// 3. releasing an overflow claim refills overflow; primaries retake only once
//    the least primary is no longer TIER_MARGIN ahead
await a.finish("c5")
const back = [await a.spawn("r2", "explore-fast"), await a.spawn("r3", "explore-fast"), await a.spawn("r4", "explore-fast"), await a.spawn("r5", "explore-fast")]
const backNums = back.map(slotNum)
assert(
  backNums.every((n) => n >= 1 && n <= SLOT_MODELS.length),
  `released slots must still route, got ${back.join(",")}`,
)
assert(
  new Set(backNums).size >= 2,
  `overflow should drain before primaries retake, got ${back.join(",")}`,
)

// 4. pool_status reports global load, models, tiers, per-process breakdown
const statusOut = await a.status()
for (const model of SLOT_MODELS) assert(statusOut.includes(model), `status should list ${model}`)
const firstPrimary = SHIPPED.findIndex((s) => s.tier === "primary") + 1
const firstOverflow = SHIPPED.findIndex((s) => s.tier === "overflow") + 1
assert(
  new RegExp(`slot ${firstPrimary} primary`).test(statusOut) && new RegExp(`slot ${firstOverflow} overflow`).test(statusOut),
  "status should label tiers",
)
assert(/across 1 process\(es\)/.test(statusOut), "solo process should report one process")

// 5. cross-process sharing: both processes MUST share one claim dir
const dir3 = mkdtempSync(join(tmpdir(), "agent-pool-share-"))
const x = await make("proc-x", dir3)
const y = await make("proc-y", dir3)
// Six spawns fill each primary twice and then one slot of each tier per round, so
// the first process must reach every slot before the second one starts.
const xCalls = []
for (let i = 1; i <= 6; i++) xCalls.push(await x.spawn(`x${i}`, "explore-fast"))
const xNums = xCalls.map(slotNum)
assert(
  new Set(xNums).size === SLOT_MODELS.length,
  `first process should reach all ${SLOT_MODELS.length} slots, got ${seq(xCalls)}`,
)
const yCalls = []
for (let i = 1; i <= 6; i++) yCalls.push(await y.spawn(`y${i}`, "explore-fast"))
// Both processes route over one shared cycle. Which slot y starts on depends on
// x's residual load, so the load check below is what proves sharing; here only
// that every pick is a declared slot.
assert(
  [...xCalls, ...yCalls].every((c) => /^explore-fast-\d+$/.test(c)),
  `routing must stay in the pool, got ${[...xCalls, ...yCalls].join(",")}`,
)
const crossStatus = await x.status()
const loadOf = (model) => {
  const line = crossStatus.split("\n").find((l) => l.includes(model))
  return line ? Number(/load=(\d+)/.exec(line)[1]) : NaN
}
// 12 spawns are split by tier, so the invariants are what hold for any slot count:
// every claim is visible to both processes, each tier is filled evenly within
// itself, and primaries keep a lead over overflow. Which slot is 1 is
// pool-models.json's business.
const loadList = SLOT_MODELS.map(loadOf)

const report = SHIPPED.map((s, i) => `${s.model}(${s.tier[0]})=${loadList[i]}`).join(" ")
const primaryLoads = PRIMARY_MODELS.map(loadOf)
const overflowLoads = OVERFLOW_MODELS.map(loadOf)
assert(loadList.reduce((a, b) => a + b, 0) === 12, `all 12 claims must be shared, got ${report}`)
// Within a tier, leastLoaded always takes the smallest, so loads stay within one
// of each other -- equal when the tiers are the same size, off by one otherwise.
const spread = (xs) => Math.max(...xs) - Math.min(...xs)
assert(spread(primaryLoads) <= 1, `primaries must stay load-balanced, got ${report}`)
assert(spread(overflowLoads) <= 1, `overflow must stay load-balanced, got ${report}`)
assert(
  primaryLoads[0] >= overflowLoads[0],
  `primaries must keep a lead over overflow, got ${report}`,
)
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
assert(/^explore-fast-\d+$/.test(degradedPick), `degraded mode should still route, got ${degradedPick}`)
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
// Everything has aged out, so the pool is idle again and hands out a primary
assert(
  PRIMARY_MODELS.includes(SLOT_MODELS[slotNum(afterTtl) - 1]),
  `TTL should empty the pool, got ${afterTtl}`,
)

// 9. untouched: non-task tool, non-pool spawn, direct variant, malformed args
const other = { args: { filePath: "/etc" } }
await a.hooks["tool.execute.before"]({ tool: "read", sessionID: "s1", callID: "x1" }, other)
assert(other.args.filePath === "/etc", "non-task tool must not be touched")
assert((await a.spawn("x2", "explore-deep")) === "explore-deep", "non-pool spawn must not be rewritten")
assert((await a.spawn("x3", "explore-fast-2")) === "explore-fast-2", "direct variant must not be rewritten")
await a.hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "x5" }, {})
await a.finish("nonexistent")

// 10. config invariants: every pooled base has one hidden variant per slot in
//     pool-models.json, each running that slot's model -- and none of them
//     hard-codes one, so the file really is the only place a pool model lives
const rawCfg = JSON.parse(readFileSync(CONFIG, "utf8"))
const BASES = ["explore-fast", "implement-fast", "context-manager"]
for (const base of BASES) {
  SLOT_MODELS.forEach((_, i) => {
    const v = `${base}-${i + 1}`
    assert(rawCfg.agent[v] !== undefined, `${v} must be declared in opencode.jsonc`)
    assert(rawCfg.agent[v].model === undefined, `${v} must not hard-code a model; pool-models.json injects it`)
  })
}
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
// opencode compiles a permission pattern to an anchored regex (* -> .*) and lets
// the longest match win, so "explore-fast*" covers the base and every variant.
// What must hold is not that each name is listed, but that a base and its variants
// resolve the same way -- otherwise the pool routes a spawn to a variant the
// caller is not allowed to run.
const compilePermission = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s")
const taskAllows = (task, target) => {
  let best
  for (const [pattern, action] of Object.entries(task)) {
    if (!compilePermission(pattern).test(target)) continue
    if (!best || pattern.length > best.pattern.length) best = { pattern, action }
  }
  return best?.action === "allow"
}
for (const [name, def] of Object.entries(cfg.agent)) {
  const task = def.permission?.task
  if (!task) continue
  for (const base of BASES) {
    for (let i = 1; i <= SLOT_MODELS.length; i++) {
      assert(
        taskAllows(task, `${base}-${i}`) === taskAllows(task, base),
        `${name}: task rule for ${base} must cover ${base}-${i} the same way`,
      )
    }
  }
}

// 10b. the one-writer agent must have no path to code execution: edit/write are
//      denied and `mkdir -p *` is denied, so an allowed `node -e *` would undo
//      every one of those rules in a single call.
const INTERPRETERS = new Set(["node", "python", "python3", "sh", "bash", "zsh", "perl", "ruby", "php", "env"])
for (const [name, def] of Object.entries(rawCfg.agent)) {
  if (!name.startsWith("context-manager")) continue
  for (const [pattern, action] of Object.entries(def.permission?.bash ?? {})) {
    if (action !== "allow" || pattern === "*") continue
    assert(!INTERPRETERS.has(pattern.split(/\s+/)[0]), `${name} may run \`${pattern}\`, which is arbitrary code execution`)
  }
}

// 10c. the generic built-in subagents must stay disabled. "explore" and "general"
//      shadow the pool: always spawnable, full-price, and a bypass around
//      explore-fast*/implement-fast*. Pinned so an opencode upgrade that
//      reintroduces (or adds) one fails here rather than quietly doubling the
//      delegation paths.
for (const builtin of ["explore", "general", "implement"]) {
  assert(rawCfg.agent[builtin]?.disable === true, `${builtin} must be disabled in opencode.jsonc`)
}
// Only the pool's implement variants may be real agents; a bare "implement" must
// stay disabled, so it must not be declared with anything but disable.
for (const [name, def] of Object.entries(rawCfg.agent)) {
  if (!/^implement(-|$)/.test(name) || name.startsWith("implement-")) continue
  assert(def.disable === true, `${name} must not be a usable agent`)
}

// 11. every pool model is free (0/0 cost) per the vendored models.dev snapshot.
//     Refreshing it is part of changing the pool: the snapshot is the record of
//     what each model cost when it was picked, and a model missing from it has not
//     been checked at all. Regenerate with the helper, which reads the current
//     pool-models.json so nothing has to be listed twice:
//       node ~/.config/opencode/tests/refresh-models-snapshot.mjs
assert(existsSync(SNAPSHOT), `missing ${SNAPSHOT}; run: node tests/refresh-models-snapshot.mjs`)
const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"))
for (const model of SLOT_MODELS) {
  const entry = snapshot.models[model]
  assert(entry, `snapshot has no ${model}; run: node tests/refresh-models-snapshot.mjs`)
  assert(entry.cost_input === 0 && entry.cost_output === 0, `${model} must be free, snapshot says ${entry.cost_input}/${entry.cost_output}`)
  assert(entry.tool_call === true, `${model} must support tool calls to be usable as an explore agent`)
}

console.log(statusOut)
rmSync(dir1, { recursive: true, force: true })
rmSync(dir3, { recursive: true, force: true })
console.log("\nALL CHECKS PASSED")