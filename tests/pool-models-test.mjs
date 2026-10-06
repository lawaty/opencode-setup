// pool-models.json is the one file a user edits to change which models the pool
// runs. This suite drives the config hook against temporary copies of that file
// and against the real opencode.jsonc, proving:
//
//   1. the shipped file parses, and its slots are distinct models with valid tiers
//   2. the config hook rewrites every variant agent's model from the file, so
//      opencode.jsonc can disagree and still lose
//   3. a model absent from a provider whitelist is whitelisted automatically,
//      since opencode deletes every model a provider offers that is not
//   4. a missing or broken file degrades to the built-in defaults with a warning
//      instead of a pool that cannot route
//   5. slot count is not baked in: three slots route 1,2,3 and the fourth agent
//      name is simply absent

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG = join(HERE, "..", "opencode.jsonc")
const MODELS = join(HERE, "..", "pool-models.json")
const PLUGIN = join(HERE, "..", "plugins", "agent-pool.ts")
const realCfg = () => JSON.parse(readFileSync(CONFIG, "utf8"))

// Each pool instance gets its own log buffer: warnOnce state is per instance, so
// sharing one buffer would let an earlier instance's warnings satisfy a later one.
const makeClient = () => {
  const lines = []
  return { lines, client: { app: { log: async ({ body }) => void lines.push(`${body.level} ${body.message}`) } } }
}
const { AgentPool } = await import(PLUGIN)

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg)
    process.exit(1)
  }
}

const dir = mkdtempSync(join(tmpdir(), "pool-models-"))
const file = (name, content) => {
  const path = join(dir, name)
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content))
  return path
}

const apply = async (modelsFile, id) => {
  const { lines, client } = makeClient()
  const claims = mkdtempSync(join(dir, "claims-"))
  const hooks = await AgentPool({ client }, { id: id ?? String(Math.random()), dir: claims, modelsFile })
  const cfg = realCfg()
  await hooks.config(cfg)
  return {
    cfg,
    spawn: async (callID, requested = "explore-fast", sessionID = "s1") => {
      const out = { args: { subagent_type: requested, prompt: "x" } }
      await hooks["tool.execute.before"]({ tool: "task", sessionID, callID }, out)
      return out.args.subagent_type
    },
    lines,
    warned: () => lines.filter((l) => l.startsWith("warn")),
  }
}

const BASES = ["explore-fast", "implement-fast", "context-manager"]

// 1. the shipped file is well formed
const shipped = JSON.parse(readFileSync(MODELS, "utf8"))
assert(Array.isArray(shipped.slots) && shipped.slots.length >= 2, "pool-models.json must list at least two slots")
const ids = new Set()
shipped.slots.forEach((slot, i) => {
  assert(typeof slot.model === "string" && slot.model.includes("/"), `slot ${i + 1} needs a provider/model-id`)
  assert(["primary", "overflow"].includes(slot.tier), `slot ${i + 1} needs tier primary or overflow`)
  assert(!ids.has(slot.model), `slot ${i + 1} repeats ${slot.model}; slots must be distinct`)
  ids.add(slot.model)
})
// two providers at most half the pool, so one provider-wide limit cannot kill it
const providers = new Set(shipped.slots.map((s) => s.model.split("/")[0]))
assert(providers.size >= 2, `the pool must span at least two providers, got ${[...providers].join(", ")}`)

// 2. a different file rewrites every variant agent, even against a config that
//    names different models and carries no whitelist entry for the new ones
const swapped = [
  { model: "opencode/big-pickle", tier: "primary" },
  { model: "opencode-go/brand-new-free", tier: "primary" },
  { model: "opencode/nemotron-3-ultra-free", tier: "overflow" },
]
const a = await apply(file("swapped.json", { slots: swapped }))
for (const base of BASES) {
  swapped.forEach((slot, i) => {
    const variant = a.cfg.agent[`${base}-${i + 1}`]
    assert(variant, `${base}-${i + 1} must exist in opencode.jsonc`)
    assert(variant.model === slot.model, `${base}-${i + 1} must run ${slot.model} from the file, got ${variant.model}`)
  })
}

// 3. whitelisting is automatic: without it opencode deletes the model from the
//    provider and the agent resolves to no model at all
for (const slot of swapped) {
  const [provider, id] = slot.model.split("/")
  assert(a.cfg.provider[provider] !== undefined, `provider ${provider} must be configured in opencode.jsonc`)
  assert(a.cfg.provider[provider].whitelist.includes(id), `${slot.model} must be whitelisted on ${provider}`)
}
assert(
  a.lines.some((l) => l.includes("whitelisted") && l.includes("brand-new-free")),
  `adding a model to a provider whitelist should be logged, got ${a.lines.join(" | ")}`,
)
// an already-whitelisted model is added exactly once
const repeats = a.cfg.provider.opencode.whitelist.filter((x) => x === "big-pickle")
assert(repeats.length === 1, `whitelist entry must not be duplicated, got ${repeats.length}`)

// 4. a three-slot file routes only 1,2,3 -- the slot count is data, not code
const picks = []
for (let i = 0; i < 6; i++) picks.push((await a.spawn(`s${i}`)).replace("explore-fast-", ""))
assert(new Set(picks).size === 3, `only three slots exist, got ${[...new Set(picks)].join(",")}`)
assert(!picks.includes("4"), "slot 4 does not exist in a three-slot file")

// 5. a missing file falls back to the built-in defaults rather than refusing to route
const missing = await apply(join(dir, "does-not-exist.json"), "missing")
assert(missing.warned().some((l) => l.includes("unreadable")), "a missing file should warn")
const fallbackPick = await missing.spawn("f1")
assert(fallbackPick === "explore-fast-1", `defaults should still route, got ${fallbackPick}`)

// 6. individual bad entries are dropped with a warning; the good slots still route
const broken = await apply(
  file("broken.json", {
    slots: [
      { model: "opencode/big-pickle", tier: "primary" },
      { model: "opencode/big-pickle", tier: "overflow" },
      { model: "opencode/nemotron-3-ultra-free", tier: "sideways" },
      { model: "opencode/nemotron-3-ultra-free", tier: "overflow" },
      { model: "nemotron-3-ultra-free", tier: "primary" },
    ],
  }),
  "broken",
)
const warns = broken.warned().filter((l) => l.includes("pool-models.json") || l.includes("slot "))
assert(warns.length === 3, `each bad entry should warn once, got ${warns.length}: ${warns.join(" | ")}`)
for (const base of BASES) {
  assert(broken.cfg.agent[`${base}-1`].model === "opencode/big-pickle", `slot 1 must run the first valid entry, got ${broken.cfg.agent[`${base}-1`].model}`)
  assert(broken.cfg.agent[`${base}-2`].model === "opencode/nemotron-3-ultra-free", `slot 2 must run the second valid entry, got ${broken.cfg.agent[`${base}-2`].model}`)
}

// 7. opencode.jsonc declares the variants with no model at all: the hook is the
//    only thing that puts one there, so there is nothing left to fall out of sync
const declared = realCfg()
for (const base of BASES) {
  for (let i = 1; i <= shipped.slots.length; i++) {
    assert(declared.agent[`${base}-${i}`] !== undefined, `${base}-${i} must be declared`)
    assert(declared.agent[`${base}-${i}`].model === undefined, `${base}-${i} must not hard-code a model`)
  }
}

// 8. the real file drives the real config unchanged
const live = await apply(MODELS, "live")
shipped.slots.forEach((slot, i) => {
  for (const base of BASES) {
    assert(live.cfg.agent[`${base}-${i + 1}`].model === slot.model, `${base}-${i + 1} must run ${slot.model}`)
  }
})
// and nothing is routed to a variant opencode.jsonc does not define
for (let i = 1; i <= shipped.slots.length; i++) {
  for (const base of BASES) assert(live.cfg.agent[`${base}-${i}`], `${base}-${i} must exist for slot ${i} of ${shipped.slots.length}`)
}

rmSync(dir, { recursive: true, force: true })
console.log("\nALL POOL-MODEL CHECKS PASSED")