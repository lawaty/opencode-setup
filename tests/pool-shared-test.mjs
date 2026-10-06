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

// pool-models.json owns the pool's models; the tests below refer to slot N's
// model, so swapping a model is not a test edit.
const SHIPPED = JSON.parse(readFileSync(join(HERE, "..", "pool-models.json"), "utf8")).slots
const SLOT_MODELS = SHIPPED.map((s) => s.model)

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
// A spawn the pool could not rewrite (because opencode.jsonc declares no variant
// for that slot) comes back unrouted, so return -1 rather than throwing.
const slotOf = (variant) => (variant === null || variant === undefined ? -1 : Number(/-(\d+)$/.exec(variant)?.[1] ?? -1))
// Slot numbers per tier, so these checks hold whatever order pool-models.json
// lists its slots in. pickSlot filters by tier, not position.
const slotsOfTier = (tier) => SHIPPED.flatMap((s, i) => (s.tier === tier ? [i + 1] : []))
const PRIMARY_SLOTS = slotsOfTier("primary")
const OVERFLOW_SLOTS = slotsOfTier("overflow")
const ALL_SLOTS = SHIPPED.map((_, i) => i + 1)
const firstOf = (xs) => xs[0]

// 1. slot N is the same model for every base, so the pool is genuinely shared
{
  for (const i of ALL_SLOTS) {
    // A slot with no declared variant in opencode.jsonc is a config gap, not a
    // sharing failure: report it instead of dereferencing undefined.
    const declared = BASES.map((b) => cfg.agent[`${b}-${i}`])
    const missing = BASES.filter((b) => !cfg.agent[`${b}-${i}`])
    if (missing.length > 0) {
      // this assert only records a failure and continues, so the body must not
      // run on the missing variants
      assert(false, `slot ${i} has no variant in opencode.jsonc for ${missing.join(",")}; add them or drop the slot from pool-models.json`)
      continue
    }
    const models = declared.map((d) => d.model)
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
  // The claim is that base type does not matter, so the reference is the same
  // number of spawns from one base type in a fresh pool. Comparing against a run
  // instead of a literal sequence keeps this independent of both the slot
  // numbering and the tier split in pool-models.json.
  const solo = await mk("shared-1-solo", scratch())
  const soloPicks = []
  for (let i = 0; i < picks.length; i++) soloPicks.push(slotOf(await solo.spawn(`s${i}`, BASES[0])))
  assert(
    picks.join(",") === soloPicks.join(","),
    `mixed base types must follow the same shared cycle, got ${picks.join(",")}, want ${soloPicks.join(",")}`,
  )
  // Primaries are used first and stay load-equalized, so the leading picks are
  // primaries until the least-loaded one is TIER_MARGIN ahead.
  assert(
    PRIMARY_SLOTS.includes(picks[0]) && PRIMARY_SLOTS.includes(picks[1]),
    `an idle pool must start on primaries, got ${picks.slice(0, 2).join(",")}`,
  )
  assert(new Set(picks).size === ALL_SLOTS.length, "every slot must be used when base types alternate")
}

// 3. load from one base displaces the other: a saturated explore-fast pushes
//    implement-fast onto the same shared slots instead of its own
{
  const t = await mk("shared-2", scratch())
  for (let i = 0; i < 2 * PRIMARY_SLOTS.length; i++) await t.spawn(`x${i}`, "explore-fast") // saturates primaries
  const afterExplore = slotOf(await t.spawn("x4", "implement-fast"))
  assert(
    afterExplore === firstOf(OVERFLOW_SLOTS),
    `implement-fast must land on the least-loaded slot, got ${afterExplore}`,
  )
  assert(!PRIMARY_SLOTS.includes(afterExplore), "implement-fast must not be handed an explore-fast-loaded primary")
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
  assert(status.includes(SLOT_MODELS[0]), "status should name the model")
  assert(/bases: explore-fast, implement-fast, context-manager/.test(status), "status should list the pooled bases")
}

// 5. context-autoupdate-style acquisition: borrow a slot, claim it, then release
{
  const dir = scratch()
  const state = pool.state({ id: "borrow", dir })
  pool.init(state, () => {})
  const snap = pool.snapshot(state)
  const slot = pool.pickSlot(state, snap)
  // an idle pool hands out a primary, whichever primary slot the file put first
  assert(PRIMARY_SLOTS.includes(slot.index), `an idle pool should hand out a primary slot, got ${slot.index}`)
  const agent = pool.agentFor("context-manager", slot.index)
  assert(agent === `context-manager-${slot.index}`, `borrowed agent name wrong: ${agent}`)
  assert(cfg.agent[agent] !== undefined, `${agent} must exist in config`)
  const key = pool.claimKey("ses_borrow", "context-autoupdate")
  pool.acquire(state, "context-manager", slot, "ses_borrow", key, "ses_borrow")
  let busy = pool.snapshot(state)
  assert(busy.counts.get(slot.model) === 1, "the borrowed slot must show as loaded")
  assert(busy.own.get(key).g === "ses_borrow", "the claim must target the working session for the reaper")
  // A second borrow must not land on the busy slot while another slot is
  // eligible. With a single primary there is nothing to switch to: the only other
  // slot is overflow and a primary keeps the lead until it is TIER_MARGIN ahead,
  // so handing the same primary again is the pool behaving as designed, not a
  // routing failure.
  const slot2 = pool.pickSlot(state, pool.snapshot(state))
  if (PRIMARY_SLOTS.length > 1) {
    assert(slot2.index !== slot.index, `second borrow should avoid the busy slot, got ${slot2.index}`)
  }
  pool.release(state, key)
  busy = pool.snapshot(state)
  assert(busy.counts.get(slot.model) === undefined, "release must clear the borrowed slot")
}

// 6. a cooled model is skipped by every base type, not just explore-fast
{
  const t = await mk("shared-4", scratch())
  // cool the first slot's model through the shared lib for this instance's dir
  const cooled = SLOT_MODELS[0]
  const state = pool.state({ id: "shared-4", dir: made[made.length - 1] })
  pool.recordStrike(state, cooled, "rate-limit", 60_000)
  const cooledSlot = SLOT_MODELS.indexOf(cooled) + 1
  const picks = []
  for (let i = 0; i < 6; i++) picks.push(slotOf(await t.spawn(`y${i}`, BASES[i % BASES.length])))
  assert(!picks.includes(cooledSlot), `no base type may use a cooled model, got ${picks.join(",")}`)
  assert(/COOLING/.test(await t.status()), "status should report the cooling model")
}

for (const d of made) rmSync(d, { recursive: true, force: true })
if (failures === 0) console.log("\nALL SHARED-POOL CHECKS PASSED")
else {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}