// Verifies the pool is genuinely shared across agent types: explore-fast,
// implement-fast and context-manager compete for the same four models, so a
// busy agent type cannot protect its own capacity. Also checks that the
// context-autoupdate plugin borrows a slot correctly.
// Run: node ~/.config/opencode/tests/pool-shared-test.mjs
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(HERE, "..", "opencode.jsonc")
const POOL = join(HERE, "..", "lib", "pool.ts")
const cfg = JSON.parse(readFileSync(CONFIG, "utf8"))

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    failures++
  }
}

const made = []
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "shared-"))
  made.push(d)
  return d
}

const logs = []
const client = { app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) } }
const { AgentPool } = await import(join(HERE, "..", "plugins", "agent-pool.ts"))
const pool = await import(POOL)

const mk = async (id, dir) => {
  const hooks = await AgentPool({ client, serverUrl: undefined }, { id, dir })
  await hooks.config(cfg)
  return {
    hooks,
    spawn: async (callID, requested, sessionID = "s1") => {
      const out = { args: { subagent_type: requested, prompt: "x" } }
      await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
      return out.args.subagent_type
    },
    status: async () => (await hooks.tool.pool_status.execute({}, {})).output,
  }
}

const BASES = ["explore-fast", "implement-fast", "context-manager"]
const slotOf = (variant) => Number(/-(\d+)$/.exec(variant)[1])

// 1. slot N is the same model for every base, so the pool is genuinely shared
{
  for (let i = 1; i <= 4; i++) {
    const models = BASES.map((b) => cfg.agent[`${b}-${i}`].model)
    assert(new Set(models).size === 1, `slot ${i} must be one model across bases, got ${models}`)
  }
}

// 2. alternating base types interleave across slots rather than each taking one
{
  const t = await mk("shared-1", scratch())
  const picks = []
  for (let i = 0; i < 9; i++) {
    const base = BASES[i % BASES.length]
    picks.push(slotOf(await t.spawn(`c${i}`, base)))
  }
  // Two primaries are filled evenly before overflow engages, so the sequence is
  // 1,2,1,2 then 3,4 — identical to the verified single-base behaviour.
  assert(
    picks.join(",") === "1,2,1,2,3,4,1,2,3",
    `mixed base types must follow the same shared cycle, got ${picks.join(",")}`,
  )
  assert(new Set(picks).size === 4, "all four slots must be used when base types alternate")
}

// 3. load from one base displaces the other: a saturated explore-fast pushes
//    implement-fast onto the same shared slots instead of its own
{
  const t = await mk("shared-2", scratch())
  for (let i = 0; i < 4; i++) await t.spawn(`x${i}`, "explore-fast") // leaves loads 2,2,0,0
  const afterExplore = slotOf(await t.spawn("x4", "implement-fast"))
  assert(afterExplore === 3, `implement-fast must land on the least-loaded slot (3), got ${afterExplore}`)
  assert(![1, 2].includes(afterExplore), "implement-fast must not be handed an explore-fast-loaded primary")
}

// 4. pool_status attributes load per model and names the agent types using it
{
  const t = await mk("shared-3", scratch())
  await t.spawn("s1", "explore-fast")
  await t.spawn("s2", "implement-fast")
  await t.spawn("s3", "context-manager")
  const status = await t.status()
  assert(/explore-fastx1/.test(status), `status should attribute explore-fast load, got:\n${status}`)
  assert(/implement-fastx1/.test(status), `status should attribute implement-fast load, got:\n${status}`)
  assert(status.includes("opencode/big-pickle"), "status should name the model")
  assert(/bases: explore-fast, implement-fast, context-manager/.test(status), "status should list the pooled bases")
}

// 5. context-autoupdate-style acquisition: borrow a slot, claim it, then release
{
  const dir = scratch()
  const state = pool.state({ id: "borrow", dir })
  pool.init(state, () => {})
  const snap = pool.snapshot(state)
  const slot = pool.pickSlot(state, snap)
  assert(slot.index === 1, `an idle pool should hand out slot 1, got ${slot.index}`)
  const agent = pool.agentFor("context-manager", slot.index)
  assert(agent === "context-manager-1", `borrowed agent name wrong: ${agent}`)
  assert(cfg.agent[agent] !== undefined, `${agent} must exist in config`)
  const key = pool.claimKey("ses_borrow", "context-autoupdate")
  pool.acquire(state, "context-manager", slot, "ses_borrow", key, "ses_borrow")
  let busy = pool.snapshot(state)
  assert(busy.counts.get(slot.model) === 1, "the borrowed slot must show as loaded")
  assert(busy.own.get(key).g === "ses_borrow", "the claim must target the working session for the reaper")
  // a second borrow must not land on the same slot
  const slot2 = pool.pickSlot(state, pool.snapshot(state))
  assert(slot2.index !== slot.index, `second borrow should avoid the busy slot, got ${slot2.index}`)
  pool.release(state, key)
  busy = pool.snapshot(state)
  assert(busy.counts.get(slot.model) === undefined, "release must clear the borrowed slot")
}

// 6. a cooled model is skipped by every base type, not just explore-fast
{
  const t = await mk("shared-4", scratch())
  // cool slot 1's model through the shared lib for this instance's dir
  const state = pool.state({ id: "shared-4", dir: made[made.length - 1] })
  pool.recordStrike(state, "opencode/big-pickle", "rate-limit", 60_000)
  const picks = []
  for (let i = 0; i < 6; i++) picks.push(slotOf(await t.spawn(`y${i}`, BASES[i % BASES.length])))
  assert(!picks.includes(1), `no base type may use a cooled model, got ${picks.join(",")}`)
  assert(/COOLING/.test(await t.status()), "status should report the cooling model")
}

for (const d of made) rmSync(d, { recursive: true, force: true })
if (failures === 0) console.log("\nALL SHARED-POOL CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}