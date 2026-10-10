// Epic A — Cost control.
//
//   US-1  bulk exploration runs on cheap/free subagents, never on the main model
//   US-2  one knob (the pool preset) selects the exploration/implementation model
//   US-3  a benchmark that MEASURES a cost comparison instead of asserting one
//
// US-3's behavioural contract is exercised here by driving the real harness in
// tests/benchmark/run.mjs as a subprocess; the harness itself is not imported,
// because the thing under test is the process a maintainer runs by hand and the
// exit code it returns to CI.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ROOT,
  bootLaCode,
  cleanupAll,
  configFor,
  emptyConfig,
  preset,
  presetModels,
  scratch,
  snapshotModels,
  spawn,
  stubInput,
} from "./_harness.mjs"

const run = promisify(execFile)
const HARNESS = join(ROOT, "tests", "benchmark", "run.mjs")

// Invented ids on real providers. A real id would prove nothing about cost
// gating: the point of these tests is that the pool never inspects price.
const PAID = "anthropic/some-expensive-model"

test.after(cleanupAll)

test("[US-1] the root agent cannot read, grep or glob, and is pointed at an exploration base", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us1-deny", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)

  const build = cfg.agent.build
  assert.ok(build, "LaCode must inject the build root agent")
  // "read-family": every tool that reads the codebase is denied by
  // configuration, not by a convention the model is asked to respect.
  for (const tool of ["read", "glob", "grep", "list"]) {
    assert.equal(build.permission[tool], "deny", `${tool} must be denied on build`)
  }
  // The call is denied AND redirected: build may spawn only the pooled bases.
  assert.equal(build.permission.task["*"], "deny", "build must not spawn arbitrary agents")
  assert.equal(build.permission.task["explore-fast*"], "allow", "build must be able to delegate exploration")
  assert.equal(build.permission.task["implement-fast*"], "allow", "build must be able to delegate implementation")
  // And it is pointed at that base in prose too, so a model that ignores the
  // permission table still gets the instruction.
  assert.match(build.prompt, /@explore-fast/, "build's prompt must name the exploration base")
  await hooks.dispose()
})

test("[US-1] a pooled spawn is rewritten to a variant whose model is a declared slot", async () => {
  const models = presetModels()
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us1-route", dir: scratch() })
  const cfg = configFor(models)
  await hooks.config(cfg)

  const { routed, model } = await spawn(hooks, cfg, { subagent: "explore-fast" })
  assert.notEqual(routed, "explore-fast", "the bare base must be rewritten to a slot variant")
  assert.match(routed, /^explore-fast-[1-9]$/, `routed to ${routed}, expected explore-fast-N`)
  assert.ok(models.includes(model), `variant model ${model} is not a slot declared in presets/free-tier.json`)
  await hooks.dispose()
})

test("[US-1] N exploration spawns over an all-zero-cost preset are never dispatched to a paid model", async () => {
  const prices = snapshotModels()
  const models = presetModels()
  // Guard the premise: if the preset ever stops being free this test would be
  // asserting nothing, so fail loudly rather than passing vacuously.
  for (const model of models) {
    const price = prices[model]
    assert.ok(price, `models-snapshot.json has never seen ${model}; run tests/refresh-models-snapshot.mjs`)
    assert.equal(price.cost_input, 0, `${model} is no longer free — this story no longer describes the shipped preset`)
    assert.equal(price.cost_output, 0, `${model} is no longer free`)
  }

  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us1-free", dir: scratch() })
  const cfg = configFor(models)
  await hooks.config(cfg)

  const dispatched = []
  const N = 12
  for (let i = 0; i < N; i++) {
    const base = i % 2 === 0 ? "explore-fast" : "implement-fast"
    const { model } = await spawn(hooks, cfg, { subagent: base, callID: `c${i}`, sessionID: `s${i}` })
    dispatched.push(model)
  }
  assert.equal(dispatched.length, N)
  for (const model of dispatched) {
    assert.ok(model, "every spawn must resolve to a model")
    assert.equal(prices[model].cost_input, 0, `${model} costs money — bulk work went to a paid model`)
  }
  await hooks.dispose()
})

test("[US-2] swapping a slot's model changes routing with no change to any agent prompt", async () => {
  const before = ["alpha/one", "beta/two"].map((model) => ({ model, weight: 1 }))
  const after = ["gamma/three", "delta/four"].map((model) => ({ model, weight: 1 }))

  const boot = async (models, tag) => {
    const stub = stubInput()
    const hooks = await bootLaCode(stub, { id: tag, dir: scratch(), models: { slots: models } })
    const cfg = configFor(models.map((s) => s.model))
    await hooks.config(cfg)
    const { routed, model } = await spawn(hooks, cfg, {})
    await hooks.dispose()
    return { routed, model, prompts: Object.fromEntries(Object.entries(cfg.agent).map(([k, v]) => [k, v.prompt])) }
  }

  const original = await boot(before, "us2-a")
  const swapped = await boot(after, "us2-b")

  // The knob moved.
  assert.equal(original.model, before[0].model, "control: the first slot serves the first spawn")
  assert.equal(swapped.model, after[0].model, "the swapped slot's model must be the one used")
  // Nothing else moved: not one prompt character differs between the two boots.
  assert.deepEqual(Object.keys(swapped.prompts), Object.keys(original.prompts), "the injected agent set must not depend on the pool")
  for (const name of Object.keys(original.prompts)) {
    assert.equal(swapped.prompts[name], original.prompts[name], `${name}'s prompt changed when only the pool preset changed`)
  }
})

test("[US-2] a model hard-coded on a pooled variant is reported as overridden and rewritten", async () => {
  const slots = [{ model: PAID, weight: 1 }]
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us2-hardcoded", dir: scratch(), models: { slots } })
  // The author's own opencode.jsonc used to carry a model here; the pool preset
  // must win, and the stale line must be named rather than silently ignored.
  const cfg = configFor([PAID])
  cfg.agent["explore-fast-1"] = { model: "stale/leftover-model", prompt: "x", permission: {} }
  await hooks.config(cfg)

  const warnings = stub.text().filter((line) => line.startsWith("warn"))
  assert.ok(
    warnings.some((line) => line.includes("explore-fast-1") && line.includes("stale/leftover-model") && line.includes("pool preset wins")),
    `expected a warning naming the hard-coded model and saying the preset wins, got:\n${warnings.join("\n")}`,
  )
  assert.equal(cfg.agent["explore-fast-1"].model, PAID, "the resolved slot model must overwrite the hard-coded one")
  await hooks.dispose()
})

test("[US-2] an invalid weight falls back to 1 with a warning, and the slot survives", async () => {
  const slots = [
    { model: "weighty/zero", weight: 0 },
    { model: "weighty/not-a-number", weight: "heavy" },
    { model: "weighty/too-big", weight: 1000 },
  ]
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us2-weight", dir: scratch(), models: { slots } })
  const cfg = configFor(slots.map((s) => s.model))
  await hooks.config(cfg)

  for (const model of slots.map((s) => s.model)) {
    assert.ok(
      stub.text().some((line) => line.startsWith("warn") && line.includes(model) && line.includes("weight must be a number")),
      `expected a weight warning naming ${model}, got:\n${stub.text().join("\n")}`,
    )
  }

  // The slots were not dropped: all three variants exist and all report w1.
  for (let index = 1; index <= slots.length; index++) {
    assert.ok(cfg.agent[`explore-fast-${index}`], `slot ${index} must survive a bad weight`)
    assert.equal(cfg.agent[`explore-fast-${index}`].model, slots[index - 1].model)
  }
  const status = await hooks.tool.pool_status.execute({}, {})
  assert.match(status.output, /slot 1 w1\s+weighty\/zero/, `pool_status must show the fallback weight:\n${status.output}`)
  assert.match(status.output, /slot 3 w1\s+weighty\/too-big/)

  // And the routing actually honours it: three slots of weight 1 serve three
  // spawns before any of them is reused.
  const seen = []
  for (let i = 0; i < 3; i++) seen.push((await spawn(hooks, cfg, { callID: `w${i}`, sessionID: `ws${i}` })).routed)
  assert.deepEqual(seen, ["explore-fast-1", "explore-fast-2", "explore-fast-3"], `weight 1 each must round-robin, got ${seen}`)
  await hooks.dispose()
})

// ---------------------------------------------------------------------------
// US-3 -- the benchmark is the deliverable, and it must not fabricate
// ---------------------------------------------------------------------------

const cells = (line) => line.split("|").map((cell) => cell.trim()).slice(1, -1)
const tableRows = (stdout) => stdout.split("\n").filter((line) => line.startsWith("| ") && !line.includes("---")).map(cells)

test("[US-3] the harness reports token counts and a cost for both runs from the same task profile", async () => {
  const { stdout } = await run(process.execPath, [HARNESS, "--allow-unknown"], { cwd: ROOT })
  const rows = tableRows(stdout)
  assert.ok(rows.length >= 3, `expected a header and one row per configuration, got:\n${stdout}`)

  // Falsifiability: the table is dated, and it names WHICH KIND of claim it is.
  // This run is the offline default, so the word must be "projected" — a header
  // claiming a measurement in simulation mode is the harness fabricating, two
  // lines above its own "these are NOT measurements".
  assert.match(stdout, /projected on \d{4}-\d{2}-\d{2}/, "the simulation table must be dated and labelled a projection")
  for (const model of presetModels()) assert.ok(stdout.includes(model), `the table must name the pooled model ${model}`)
  assert.match(stdout, /baseline/i, "the unpooled run must be present and named")

  const baseline = rows.find((row) => /baseline/i.test(row[0]))
  const pooled = rows.find((row) => /lacode/i.test(row[0]))
  assert.ok(baseline && pooled, `expected a baseline row and a LaCode row:\n${stdout}`)

  // Same input on both sides: identical token counts, because the same task
  // profile was priced twice. That is what makes this a comparison at all.
  assert.deepEqual(baseline.slice(2, 5), pooled.slice(2, 5), `both runs must price the same work:\n${stdout}`)

  // Token counts are computed from the profile, not asserted.
  const calls = Number(baseline[2])
  const input = Number(baseline[3].replace(/[^\d]/g, ""))
  const output = Number(baseline[4].replace(/[^\d]/g, ""))
  assert.ok(calls > 0 && input > 0 && output > 0, `token counts must be derived from the profile:\n${stdout}`)
  assert.equal(input / calls, 12000, "input tokens must equal calls x tokens-per-call")
  assert.equal(output / calls, 1500, "output tokens must equal calls x tokens-per-call")

  // A cost is reported for the pooled side: measured, not assumed.
  assert.match(pooled[5], /^\$/, `the pooled cost must be a computed figure, got "${pooled[5]}"`)
  assert.equal(Number(pooled[5].replace(/[^0-9.]/g, "")), 0, "the bundled preset is free, so its projected cost is 0")
})

test("[US-3] a free model is priced as 0, never as unknown or omitted", async () => {
  const prices = snapshotModels()
  const { stdout } = await run(process.execPath, [HARNESS, "--allow-unknown"], { cwd: ROOT })
  const pooled = tableRows(stdout).find((row) => /lacode/i.test(row[0]))
  for (const model of presetModels()) {
    assert.ok(prices[model], `control: ${model} must be in the pinned snapshot`)
    assert.ok(pooled[1].includes(model), `${model} must appear in the pooled row, not be omitted`)
  }
  assert.doesNotMatch(pooled[5], /unknown/i, `a snapshot-covered free model must price as 0, not unknown: "${pooled[5]}"`)
  assert.equal(Number(pooled[5].replace(/[^0-9.]/g, "")), 0, "free is 0, which is a price, not a missing one")
})

test("[US-3] a model with no price in the snapshot fails loudly instead of reporting 0 cost", async () => {
  const missing = "nobody/never-heard-of-it"
  assert.ok(!snapshotModels()[missing], "control: this model must not be in the snapshot")

  const { stdout, stderr } = await run(process.execPath, [HARNESS, "--baseline-model", missing], { cwd: ROOT }).catch((e) => e)
  const out = `${stdout}${stderr}`

  // Loud: the model is named, the refusal to guess is explicit, and the caller
  // who asked for that model by name gets a non-zero exit.
  assert.match(out, new RegExp(`no price[^\\n]*${missing}`), `the missing price must be named loudly:\n${out}`)
  assert.match(out, /unknown, NOT 0/, `the refusal to guess must be explicit:\n${out}`)

  const row = tableRows(stdout).find((c) => c[1].includes(missing))
  assert.ok(row, `expected a row for the unpriced model:\n${stdout}`)
  assert.match(row[5], /unknown/i, `the cell must read unknown:\n${row}`)
  // The critical half: 0 is never printed as the price of an unpriced model.
  assert.doesNotMatch(row[5], /^0(\.0+)?$/, `an unpriced model must never be shown as costing 0: ${row[5]}`)
})

test("[US-3] a named model with no price exits non-zero; an unrequested one still succeeds", async () => {
  const missing = "nobody/never-heard-of-it"
  const strict = await run(process.execPath, [HARNESS, "--baseline-model", missing], { cwd: ROOT }).catch((e) => e)
  assert.equal(strict.code, 3, "an explicitly requested unpriced model must fail loudly (US-3)")

  // The default baseline is not a request, so a table carrying an unknown cell
  // is still a successful offline run -- but the unknown must still be called out.
  // Resolving at all IS the zero exit: execFile rejects on non-zero.
  const lenient = await run(process.execPath, [HARNESS], { cwd: ROOT })
  assert.match(lenient.stderr, /NOT 0/, "the unknown baseline must still be named on stderr")
})

test("[US-3] the harness stores no savings constant and derives every ratio it prints", async () => {
  // The regression this story exists to prevent is someone editing the harness
  // to print a number they already believed. A stored constant is mechanical to
  // find; a derived value is not. Assert on the source, not just on today's run.
  const source = readFileSync(HARNESS, "utf8")
  const code = source.split("\n").filter((line) => !line.trimStart().startsWith("//"))
  const constant = code.find((line) => /\b(save|saving|savings|cheaper|reduction|ratio)\w*\s*[:=]\s*[\d.]+\s*%?/i.test(line))
  assert.equal(constant, undefined, `the harness must not store a savings constant: ${constant}`)
  const literal = code.find((line) => /["'`][^"'`]*\d+(\.\d+)?\s*%/.test(line))
  assert.equal(literal, undefined, `the harness must not print a percentage literal: ${literal}`)

  // What it does print, it derives: the difference line names both operands.
  const { stdout } = await run(process.execPath, [HARNESS, "--allow-unknown"], { cwd: ROOT })
  for (const line of stdout.split("\n").filter((l) => l.includes("%"))) {
    assert.match(line, /computed from the two rows above|Difference/, `a printed ratio must name its derivation: ${line}`)
  }
})

test("[US-3] the harness prices offline from the pinned snapshot and labels a simulation a projection", async () => {
  const { stdout } = await run(process.execPath, [HARNESS, "--allow-unknown"], { cwd: ROOT })
  assert.ok(stdout.includes("tests/models-snapshot.json"), "the pricing source must be named so a number can be audited")
  assert.match(stdout, /fetched \d{4}-\d{2}-\d{2}/, "the snapshot's own fetch date must be shown")
  assert.match(stdout, /PROJECTED/, "a simulated run must label itself a projection, not a measurement")
  assert.doesNotMatch(stdout, /models\.dev\/api/i, "the default path must price from the pinned snapshot, not the live API")
})

test("[US-3] real-run mode without credentials skips and exits 0 instead of failing or inventing numbers", async () => {
  const env = { ...process.env }
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY", "OPENCODE_BIN"]) delete env[key]
  const emptyHome = scratch("no-home-")
  const { stdout } = await run(process.execPath, [HARNESS, "--real"], {
    cwd: ROOT,
    env: { ...env, HOME: emptyHome, XDG_DATA_HOME: join(emptyHome, ".local", "share") },
  })
  assert.match(stdout, /SKIPPED/i, `a missing-credential run must say so plainly:\n${stdout}`)
  assert.match(stdout, /no API credentials/i)
  assert.doesNotMatch(stdout, /^\|\s*LaCode/m, "a skipped run must not print a results table")
  assert.doesNotMatch(stdout, /\d+(\.\d+)?\s*%/, "a skipped run must not report a ratio")
})

test("[US-2] the shipped preset parses into distinct models with valid weights", () => {
  // The one file a user edits to change cost strategy. A typo here silently
  // changes routing, so it is asserted rather than trusted.
  const slots = preset().slots
  assert.ok(slots.length > 0)
  const seen = new Set()
  for (const slot of slots) {
    assert.ok(slot.model.includes("/"), `model must be provider/model-id: ${JSON.stringify(slot)}`)
    assert.ok(!seen.has(slot.model), `duplicate slot model ${slot.model}`)
    seen.add(slot.model)
    assert.equal(typeof slot.weight, "number", `weight must be a number: ${JSON.stringify(slot)}`)
    assert.ok(slot.weight > 0 && slot.weight <= 100, `weight out of range: ${JSON.stringify(slot)}`)
  }
})
