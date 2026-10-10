// Epic G — Context and cost.
//
//   US-19  a curated map replaces cold exploration
//   US-20  the map stays current without being asked
//   US-21  one writer keeps the map coherent
//   US-22  on-demand map operations: /context-init, /context-update, /context-review
//
// The feature under test is the codemap at `.opencode/context/`: five files, one
// writing agent, an automatic refresh, and three slash commands.
//
// Two things are asserted here that no other suite asserts, and both are worth
// saying out loud because they are the parts that silently rot:
//
//   * US-20 drives `contextAutoUpdateHooks` — the real hook factory — with a stub
//     client, a temp project root and a temp HOME. Nothing spawns a model, but
//     every decision the plugin makes (bootstrap vs update, which paths count,
//     which slots get borrowed, whether a run actually changed anything) is the
//     one it would make in a live session. That is the only honest way to test a
//     plugin whose whole job is to fire something off asynchronously.
//   * US-21 evaluates the INJECTED permission table the way opencode evaluates it
//     rather than asserting that the strings are present. A rule can contain the
//     right text and still never match, which is exactly how this map went stale
//     for three days in production (see src/lib/writer-rule.ts).

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AGENTS, POOLED_BASES } from "../../src/agents.ts"
import { COMMANDS, STANDING_INSTRUCTION } from "../../src/commands.ts"
import { MAX_SLOTS } from "../../src/lib/pool.ts"
import { verifyWriterRule } from "../../src/lib/writer-rule.ts"
import { contextAutoUpdateHooks } from "../../src/plugins/context-autoupdate.ts"
import { ROOT, bootLaCode, cleanupAll, emptyConfig, fakeClock, presetModels, scratch, settle, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

/** The five files the cartographer owns, and the map is exactly these. */
const MAP_FILES = ["architecture.md", "contexts.md", "conventions.md", "workflows.md", "decisions.md"]

/** A file inside the map, in the form opencode evaluates it from a normal root. */
const MAP_FILE = ".opencode/context/architecture.md"

// ---------------------------------------------------------------------------
// A permission evaluator, copied from opencode's semantics as documented in
// src/lib/writer-rule.ts: patterns compile to ANCHORED regexes (* -> .*), the
// LONGEST matching pattern wins, and a plain string is the verdict outright.
// Asserting on rule *strings* would pass for a rule that matches nothing.
// ---------------------------------------------------------------------------

const patternMatches = (pattern, file) => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s").test(file)
}

/** What a `permission` entry says about writing `file`. */
const verdict = (rule, file) => {
  if (rule === undefined) return "allow" // an unconfigured tool is not restricted
  if (typeof rule === "string") return rule
  let best
  for (const [pattern, value] of Object.entries(rule)) {
    if (!patternMatches(pattern, file)) continue
    if (best === undefined || pattern.length > best.pattern.length) best = { pattern, value }
  }
  if (best === undefined) return rule["*"] ?? "allow"
  return best.value
}

/** Could this agent write inside the codemap at all? */
const canWriteMap = (permission) =>
  verdict(permission?.edit, MAP_FILE) === "allow" || verdict(permission?.write, MAP_FILE) === "allow"

/**
 * Run with a temporary HOME.
 *
 * `pool.state()` is called with no arguments by the autoupdate factory, so it
 * resolves its claim directory from $HOME at that moment. Pointing HOME at a
 * temp directory is what keeps these tests off the real
 * ~/.local/share/opencode/agent-pool — the same trick f-adoption-safety uses for
 * the fresh-install fixture.
 */
const withHome = async (home, fn) => {
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  }
}

/**
 * Boot only the autoupdate factory against a throwaway project.
 *
 * The session table always carries a root session ("root"): a session with no
 * parentID. Child sessions are supplied per-test, because "only the root
 * session refreshes the map" is itself one of the things US-20 asserts.
 */
const bootAutoupdate = async ({ withMap = false, sessions = {} } = {}) => {
  const root = scratch("proj-")
  const mapDir = join(root, ".opencode", "context")
  if (withMap) {
    mkdirSync(mapDir, { recursive: true })
    for (const name of MAP_FILES) writeFileSync(join(mapDir, name), `# ${name}\n`)
  }
  const stub = stubInput({
    sessions: { root: { id: "root", title: "main" }, ...sessions },
    directory: root,
  })
  const home = scratch("home-")
  const hooks = await withHome(home, () => contextAutoUpdateHooks(stub.input))
  return { stub, hooks, root, mapDir, home }
}

/** A promise the test resolves by hand, so an in-flight turn stays observable. */
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Make the cartographer actually change the map, so "did anything land?" is honest. */
const writesOnPrompt = (stub, mapDir) => {
  stub.client.session.prompt = async (input) => {
    stub.prompts.push(input)
    writeFileSync(join(mapDir, "architecture.md"), "# architecture.md\n\nupdated by this run\n")
    return { data: { info: {} } }
  }
}

const claimsDir = (home) => join(home, ".local", "share", "opencode", "agent-pool")
const claimFiles = (home) => {
  const dir = claimsDir(home)
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("claims.")) : []
}

/**
 * Every claim key this process currently publishes, across its claim files.
 *
 * The file itself is always rewritten (an empty payload still gets published),
 * so what matters is whether a claim for a given session is in it — not whether
 * the file exists.
 */
const liveClaims = (home) =>
  claimFiles(home).flatMap((name) => Object.keys(JSON.parse(readFileSync(join(claimsDir(home), name), "utf8"))))

/** The prompt text the cartographer was actually handed. */
const promptedWith = (stub) => stub.prompts[0].body.parts[0].text

// ---------------------------------------------------------------------------
// US-19 — a curated map replaces cold exploration
// ---------------------------------------------------------------------------

test("[US-19] the cartographer is injected as a pooled subagent, with no model of its own", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us19-inject", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  const cm = cfg.agent["context-manager"]
  assert.ok(cm, "context-manager must be injected for anyone who has not defined one")
  assert.equal(cm.mode, "subagent", "the cartographer is a subagent, never a root agent")
  assert.ok(POOLED_BASES.includes("context-manager"), `context-manager must be a pooled base: ${POOLED_BASES.join(", ")}`)
  // The pool is the only thing that decides which model runs a pooled agent, so
  // a model written next to the agent would be a second source of truth that
  // silently wins whenever routing falls through.
  assert.equal(AGENTS["context-manager"].model, undefined, "the definition must not carry a model")
  // And the model the pool bound is a real slot, not something invented here.
  const models = presetModels()
  assert.ok(cfg.agent["context-manager-1"], "a slot variant must exist for slot 1")
  assert.ok(models.includes(cfg.agent["context-manager-1"].model), `variant model ${cfg.agent["context-manager-1"].model} is not a declared slot`)
})

test("[US-19] every slot the pool can hand out has a hidden cartographer variant", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us19-variants", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  // Cartography must borrow shared capacity rather than add a model of its own:
  // if there were no variant for a slot, the automatic run would have nowhere
  // to land and would either fail or escape the pool's accounting.
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const variant = cfg.agent[`context-manager-${slot}`]
    assert.ok(variant, `hidden variant context-manager-${slot} must exist for slot ${slot}`)
    assert.equal(variant.hidden, true, `context-manager-${slot} must be hidden`)
  }
  assert.equal(cfg.agent[`context-manager-${MAX_SLOTS + 1}`], undefined, "no variant may exist beyond the pool's slot cap")

  // A hidden variant is the same agent as its base, so routing through a slot
  // cannot escape the base's instructions or its permissions.
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    assert.deepEqual(
      cfg.agent[`context-manager-${slot}`].permission,
      cfg.agent["context-manager"].permission,
      `context-manager-${slot} must carry the base agent's permissions unchanged`,
    )
  }
})

test("[US-19] the map protocol reaches every agent as a standing rule", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us19-standing", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  assert.deepEqual(cfg.instructions, [STANDING_INSTRUCTION], "the rule must be injected when the user has none")
  for (const name of MAP_FILES) {
    assert.ok(STANDING_INSTRUCTION.includes(name), `the standing rule must name ${name} so an agent knows what it may read`)
  }
  // "Check the map, don't go cold" only pays off if the check is cheap and the
  // result is used: one file, then the entry points it lists.
  assert.match(STANDING_INSTRUCTION, /ls \.opencode\/context/, "the check must be ls, not a glob that skips hidden directories")
  assert.match(STANDING_INSTRUCTION, /never the\s+`glob`/, "the rule must say the glob tool does not see it")
  assert.match(STANDING_INSTRUCTION, /canonical entry points/, "the rule must send the agent to the entry points the map lists")
  assert.match(STANDING_INSTRUCTION, /trust the code/i, "the map is an index; source stays authoritative")
})

test("[US-19] the cartographer is told to write an index, not an inventory", async () => {
  const prompt = AGENTS["context-manager"].prompt

  // The map has one job: answer "what should I look at first?". A cartographer
  // that writes a directory listing has produced something more expensive than
  // the exploration it was meant to replace.
  for (const name of MAP_FILES) {
    assert.ok(prompt.includes(name), `the prompt must define what ${name} is for`)
  }
  assert.match(prompt, /Start here/, "each subsystem must get a canonical start-here list")
  assert.match(prompt, /file inventories or directory listings/i, "inventories must be forbidden by name")
  assert.match(prompt, /REDUCE context consumption/, "the map must be kept small on purpose")
  // And the scope it must refuse to widen, or it drifts into the user's home
  // directory and the next agent trusts whatever it found there.
  assert.match(prompt, /Stay inside this project/, "the cartographer must be fenced to the repository")
})

// ---------------------------------------------------------------------------
// US-20 — the map stays current without being asked
// ---------------------------------------------------------------------------

test("[US-20] a tracked edit followed by the root session going idle spawns the cartographer", async () => {
  const { stub, hooks, root } = await bootAutoupdate()
  await hooks.event({ event: { type: "file.edited", properties: { file: "src/tunnel/index.ts" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })

  assert.equal(stub.created.length, 1, `expected one cartographer session, got ${JSON.stringify(stub.created)}`)
  assert.match(stub.created[0].title, /^context-manager \(auto (bootstrap|update)\)$/, "the run must be labelled so a log reader can tell what it was")
  assert.equal(stub.prompts.length, 1, "the session must be prompted, not merely created")

  // It borrows a pool slot rather than pinning a model: cartography is bulk work.
  const agent = stub.prompts[0].body.agent
  assert.match(agent, /^context-manager-[1-9]$/, `the run must use a slot variant, got ${agent}`)
  const borrowed = stub.text().find((line) => line.includes("borrowed pool slot"))
  assert.ok(borrowed, `borrowing a slot must be reported:\n${stub.text().join("\n")}`)
  assert.ok(presetModels().some((model) => borrowed.includes(model)), `the borrowed slot must be a declared slot: ${borrowed}`)

  // The prompt tells it what changed and where it is, so the run starts narrow.
  const text = promptedWith(stub)
  assert.ok(text.includes(root), "the run must be told the project root")
  assert.ok(text.includes("src/tunnel/index.ts"), "the edited path must be listed as starting context")
})

test("[US-20] the run is told to bootstrap when the map is absent and to update when it exists", async () => {
  const cold = await bootAutoupdate({ withMap: false })
  await cold.hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await cold.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  assert.match(cold.stub.created[0].title, /auto bootstrap\)$/, "no map yet means bootstrap")
  assert.match(promptedWith(cold.stub), /Bootstrap the repository context map/, "the bootstrap procedure must be invoked")

  const warm = await bootAutoupdate({ withMap: true })
  await warm.hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await warm.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  assert.match(warm.stub.created[0].title, /auto update\)$/, "an existing map means incremental update")
  const text = promptedWith(warm.stub)
  assert.match(text, /Incremental context update/, "the update procedure must be invoked")
  // An update that rewrites the map wholesale is a regression, not a refresh.
  assert.match(text, /no update needed/, "the run must be allowed to conclude that nothing changed")
})

test("[US-20] idle with nothing pending, a child session, or an ignored path spawns nothing", async () => {
  const idle = await bootAutoupdate()
  await idle.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  assert.equal(idle.stub.created.length, 0, "an idle session that changed nothing must not spend a cartography run")

  // Child sessions go idle constantly, mid-task. If each one refreshed the map
  // the map would be rewritten by a dozen concurrent subagents.
  const child = await bootAutoupdate({ sessions: { kid: { id: "kid", parentID: "root" } } })
  await child.hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await child.hooks.event({ event: { type: "session.idle", properties: { sessionID: "kid" } } })
  assert.equal(child.stub.created.length, 0, "a subagent going idle must not refresh the map")

  // Generated output, vendored trees and the map's own writes are not facts
  // about the repository, and the cartographer's own writes must never re-trigger it.
  const noise = await bootAutoupdate()
  for (const file of [
    "node_modules/dep/index.js",
    "dist/bundle.js",
    "coverage/lcov.info",
    ".opencode/context/architecture.md",
    "../elsewhere/file.ts",
  ]) {
    await noise.hooks.event({ event: { type: "file.edited", properties: { file } } })
  }
  await noise.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  assert.equal(noise.stub.created.length, 0, "generated, vendored, out-of-project and map-internal paths must not schedule a run")
})

test("[US-20] the borrowed slot is released and the cartographer going idle does not start a second run", async () => {
  const { stub, hooks, mapDir, home } = await bootAutoupdate({ withMap: true })
  // Hold the turn open so the window in which the slot is held is observable:
  // a prompt that resolves instantly releases the claim before the test can see it.
  const turn = deferred()
  stub.client.session.prompt = async (input) => {
    stub.prompts.push(input)
    writeFileSync(join(mapDir, "architecture.md"), "# architecture.md\n\nupdated by this run\n")
    return turn.promise
  }

  await hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  assert.equal(stub.created.length, 1, "the first run must have happened")
  assert.ok(liveClaims(home).includes("created-1:context-autoupdate"), "the borrowed slot must be claimed while the cartographer runs")

  // The cartographer is itself a session, and it goes idle when it finishes.
  // Treating that as a new work session is how a single edit turns into a
  // cartography loop.
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "created-1" } } })
  assert.equal(stub.created.length, 1, "the cartographer's own idle event must not schedule a second run")

  // And the slot goes back to the pool when the turn ends, so a cartography run
  // does not permanently cost the user one of four concurrent slots.
  turn.resolve({ data: { info: {} } })
  await settle()
  assert.deepEqual(liveClaims(home), [], "the borrowed slot must be released when the run finishes")
  assert.ok(stub.lines.some((line) => line.message === "auto update finished"), "the run must be reported as finished")
})

test("[US-20] a run that changed nothing on disk is reported as such, not as success", async () => {
  // The failure this exists for: a cartographer blocked from writing resolves
  // exactly like one that succeeded, so every run claimed success while the map
  // sat untouched. Counting what landed on disk is the only honest signal.
  const { stub, hooks, mapDir } = await bootAutoupdate({ withMap: true })
  await hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await settle()

  const blocked = stub.lines.find((line) => line.message.includes("without changing the map"))
  assert.ok(blocked, `a run that changed nothing must say so:\n${stub.text().join("\n")}`)
  assert.equal(blocked.level, "warn", "a run that changed nothing is not a success")
  assert.ok(!stub.lines.some((line) => line.message === "auto update finished"), "success must not be claimed")
  assert.match(blocked.extra.hint, /one-writer/, "the message must point at the likeliest cause")

  // Contrast: a run that really wrote the file reports the change it made.
  const real = await bootAutoupdate({ withMap: true })
  writesOnPrompt(real.stub, real.mapDir)
  await real.hooks.event({ event: { type: "file.edited", properties: { file: "src/index.ts" } } })
  await real.hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await settle()

  const finished = real.stub.lines.find((line) => line.message === "auto update finished")
  assert.ok(finished, `a real change must be reported as finished:\n${real.stub.text().join("\n")}`)
  assert.ok(finished.extra.changed >= 1, `the count of changed map files must be reported, got ${finished.extra.changed}`)
})

test("[US-20] a failed run releases its slot and requeues its paths instead of stranding them", async () => {
  const clock = fakeClock()
  const { stub, hooks, home } = await bootAutoupdate({ withMap: true })
  stub.client.session.prompt = async (input) => {
    stub.prompts.push(input)
    throw new Error("provider exploded")
  }

  await hooks.event({ event: { type: "file.edited", properties: { file: "src/tunnel/index.ts" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await settle()

  assert.equal(stub.prompts.length, 1, "the first run must have happened")
  assert.ok(stub.text().some((line) => line.includes("failed")), `a failed run must be reported:\n${stub.text().join("\n")}`)
  assert.deepEqual(liveClaims(home), [], "a failed run must release the slot it borrowed")

  // The cartographer session going idle clears the in-progress marker, then the
  // cooldown expires; the requeued path must still be in the next run.
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "created-1" } } })
  clock.advance(11 * 60 * 1000)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })

  assert.equal(stub.created.length, 2, `the requeued path must produce a second run:\n${stub.text().join("\n")}`)
  assert.ok(stub.prompts[1].body.parts[0].text.includes("src/tunnel/index.ts"), "a failed run's paths must survive to the next one")
  await hooks.dispose?.()
})

// ---------------------------------------------------------------------------
// US-21 — one writer keeps the map coherent
// ---------------------------------------------------------------------------

/** Is the map granted to this agent by an explicit allow RULE (not a blanket tool grant)? */
const grantsMapByRule = (permission) =>
  [permission?.edit, permission?.write].some(
    (rule) =>
      rule !== null &&
      typeof rule === "object" &&
      Object.entries(rule).some(
        ([pattern, value]) => pattern !== "*" && value === "allow" && patternMatches(pattern, MAP_FILE),
      ),
  )

test("[US-21] only the cartographer is granted the map by permission, and it may write nothing else", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us21-writers", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  // Evaluated, not string-matched: a rule can name the map and still never fire.
  //
  // "Granted by rule" is the exact claim, and it is narrower than it looks.
  // `build`, `implement-fast` and `implement-deep` hold a blanket
  // `"edit": "allow"`, so opencode does not stop THEM from touching the map —
  // what stops them is the standing rule telling every agent never to edit it
  // (asserted separately below). That is how this package ships today, in
  // opencode.jsonc as well as here, and a test claiming otherwise would be
  // asserting a permission table nobody wrote.
  const granted = Object.entries(cfg.agent)
    .filter(([, def]) => !def.hidden)
    .filter(([, def]) => grantsMapByRule(def.permission))
    .map(([name]) => name)
  assert.deepEqual(granted, ["context-manager"], `only the cartographer may be granted the map by rule; these others are: ${granted.join(", ")}`)

  // The read-only tiers are stopped by permission, which is the stronger half:
  // there is nothing there for them to disobey.
  for (const name of ["explore-fast", "explore-deep", "plan"]) {
    assert.equal(canWriteMap(cfg.agent[name].permission), false, `${name} must be denied the map by permission`)
  }

  // And the cartographer's grant is narrow: the map, and nothing else.
  const cm = cfg.agent["context-manager"]
  for (const tool of ["edit", "write"]) {
    assert.equal(verdict(cm.permission[tool], MAP_FILE), "allow", `the cartographer must be able to ${tool} inside the map`)
    assert.equal(verdict(cm.permission[tool], "src/index.ts"), "deny", `the cartographer must not be able to ${tool} source code`)
  }
})

test("[US-21] the writer rule covers both path spellings opencode actually evaluates", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us21-spellings", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  const edit = cfg.agent["context-manager"].permission.edit
  // Normally-rooted project: the evaluated path is relative to the project root.
  assert.equal(verdict(edit, ".opencode/context/architecture.md"), "allow", "the relative spelling must be allowed")
  // Project root "/": the same file is evaluated as home/<you>/.opencode/context/...
  assert.equal(verdict(edit, "home/someone/.opencode/context/architecture.md"), "allow", "the leading-* spelling must be allowed too")
  // …and the cost of allowing both must be zero: nothing outside the map opens up.
  for (const file of ["src/index.ts", ".opencode/contexts/architecture.md", "context/architecture.md", ".opencode/plans/plan.md"]) {
    assert.equal(verdict(edit, file), "deny", `${file} must stay closed to the cartographer`)
  }
})

test("[US-21] the injected writer rule passes the verifier, and a broken one is reported instead of silently unwritable", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us21-verify", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  // The detector src/plugins/context-autoupdate.ts runs at startup, fed the
  // injected rule as a user would have written it in opencode.jsonc.
  const configFile = (permission) => {
    const file = join(scratch("cfg-"), "opencode.jsonc")
    writeFileSync(file, `{"agent":{"context-manager":{"permission":${JSON.stringify(permission)}}}}`)
    return file
  }
  const shipped = configFile(cfg.agent["context-manager"].permission)
  for (const [root, map] of [
    ["/srv/work/app", "/srv/work/app/.opencode/context"],
    ["/", "/home/someone/.opencode/context"],
  ]) {
    const problem = verifyWriterRule(shipped, map, root)
    assert.equal(problem, undefined, `the injected rule must be writable for root ${root}: ${problem}`)
  }

  // Drop one spelling — the exact regression this detector exists for — and the
  // report must name what it saw, what is wrong, and what the fix is.
  const broken = configFile({
    edit: { "*": "deny", "*/.opencode/context/**": "allow" },
    write: { "*": "deny", "*/.opencode/context/**": "allow" },
  })
  const problem = verifyWriterRule(broken, "/srv/work/app/.opencode/context", "/srv/work/app")
  assert.ok(problem, `a rule that matches nothing must be reported:\n${JSON.stringify(broken)}`)
  assert.match(problem, /not writable/, "the report must say the map cannot be written")
  assert.match(problem, /\*\/\.opencode\/context/, "the report must quote the rule it saw")
  assert.match(problem, /Allow both forms/, "the report must state the fix")
  assert.match(problem, /RELATIVE TO THE PROJECT ROOT/, "the report must state why the rule does not fire")
})

test("[US-21] non-cartographer agents are told to report map changes rather than make them", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us21-report", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  // Ownership is enforced twice, and both halves matter: the permission denies
  // the write, and the instruction tells the agent what to do instead. Without
  // the second half an agent that tries, fails, and reports "permission denied"
  // has told the user nothing.
  assert.match(STANDING_INSTRUCTION, /Never edit `\.opencode\/context\/`/, "the standing rule must forbid editing the map")
  assert.match(STANDING_INSTRUCTION, /context-manager agent owns it/, "the standing rule must name the owner")
  assert.match(STANDING_INSTRUCTION, /final report/, "the standing rule must say where to report instead")
  assert.match(STANDING_INSTRUCTION, /Source code is authoritative/, "the map must never outrank the code")

  // Every other tier carries the same rule inline, so an agent that was given a
  // narrow prompt and never read the standing rule still cannot go rogue.
  for (const name of ["build", "plan", "explore-fast", "explore-deep", "implement-fast", "implement-deep"]) {
    assert.match(cfg.agent[name].prompt, /\.opencode\/context\//, `${name}'s prompt must mention the map`)
    assert.match(cfg.agent[name].prompt, /context-manager|context-update/, `${name}'s prompt must say who owns it`)
  }
})

// ---------------------------------------------------------------------------
// US-22 — on-demand map operations
// ---------------------------------------------------------------------------

test("[US-22] the three context commands are injected, each targeting the cartographer as a subtask", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us22-inject", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  for (const name of ["context-init", "context-update", "context-review"]) {
    const def = cfg.command[name]
    assert.ok(def, `/${name} must be injected`)
    assert.equal(def.agent, "context-manager", `/${name} must delegate to the cartographer`)
    assert.equal(def.subtask, true, `/${name} must run as a subtask so it cannot become a root session`)
    assert.ok(def.description && def.description.length > 0, `/${name} must describe itself in the command list`)
    assert.ok(def.template.length > 100, `/${name} must carry a real template, not a one-line stub`)
  }
})

test("[US-22] $ARGUMENTS substitution puts the user's focus in the update command and leaves the procedure intact", async () => {
  const template = COMMANDS["context-update"].template
  assert.ok(template.includes("$ARGUMENTS"), "the update command must expose a focus placeholder")

  // opencode substitutes the placeholder itself; what matters is that the
  // template is built so a plain substitution produces a usable prompt.
  const focus = "src/tunnel/** and the SSH payload contract"
  const rendered = template.replaceAll("$ARGUMENTS", focus)
  assert.ok(rendered.includes(`Focus: ${focus}`), "the focus must land where the placeholder was")
  assert.ok(!rendered.includes("$ARGUMENTS"), "no placeholder may survive substitution")
  assert.ok(rendered.includes("git status"), "the surrounding procedure must survive substitution")
  assert.ok(rendered.includes('report\n"no update needed"') || rendered.includes('"no update needed"'), "the no-op escape hatch must survive")
  assert.equal(rendered.length - focus.length + focus.length, template.length - "$ARGUMENTS".length + focus.length)

  // The other two take no arguments, so they must carry none — an unresolved
  // placeholder would reach the model as literal text.
  for (const name of ["context-init", "context-review"]) {
    assert.ok(!COMMANDS[name].template.includes("$ARGUMENTS"), `/${name} takes no arguments and must not declare a placeholder`)
  }
})

test("[US-22] each command names the procedure it delegates and nothing is left unresolved", async () => {
  const procedures = {
    "context-init": /bootstrap|verify and refresh/i,
    "context-update": /incremental/i,
    "context-review": /review/i,
  }
  for (const [name, procedure] of Object.entries(procedures)) {
    assert.match(COMMANDS[name].template, procedure, `/${name} must invoke its own procedure`)
    assert.match(COMMANDS[name].template, /system\s+prompt/, `/${name} must defer to the cartographer's prompt, not duplicate it`)
  }
  // A review is the one run that must not touch code, so that rule belongs in
  // the command itself rather than in the cartographer's general instructions.
  assert.match(COMMANDS["context-review"].template, /read-only for this run/, "a review must declare its read-only scope")
  assert.match(COMMANDS["context-review"].template, /\.opencode\/context\//, "a review must name where its fixes are allowed")
})

test("[US-22] a user-defined context command is left byte-identical while the other two are still added", async () => {
  const mine = { template: "MY OWN REVIEW", description: "mine", agent: "build" }
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us22-clobber", dir: scratch() })
  const cfg = { command: { "context-review": { ...mine } } }
  await hooks.config(cfg)
  await hooks.dispose()

  assert.deepEqual(cfg.command["context-review"], mine, "a user's own /context-review must survive untouched")
  assert.ok(cfg.command["context-init"], "the commands nobody claimed must still be added")
  assert.ok(cfg.command["context-update"], "the commands nobody claimed must still be added")
})

test("[US-22] every injected command resolves to an agent that exists in the same config", async () => {
  const stub = stubInput()
  const hooks = await bootLaCode(stub, { id: "us22-resolve", dir: scratch() })
  const cfg = emptyConfig()
  await hooks.config(cfg)
  await hooks.dispose()

  // A command pointing at an agent the user disabled is a dead slash command:
  // it appears in the list and does nothing when typed.
  for (const [name, def] of Object.entries(cfg.command)) {
    if (!def.agent) continue
    assert.ok(cfg.agent[def.agent], `/${name} targets ${def.agent}, which is not in this config`)
  }
  for (const name of ["context-init", "context-update", "context-review"]) {
    assert.ok(cfg.agent[cfg.command[name].agent], `/${name} must resolve to a real agent`)
  }
})

test("[US-22] the shipped package documents the same three commands the plugin injects", async () => {
  // The command set is also a published surface: the package ships `docs/`, and
  // a doc that lists commands the plugin stopped injecting is worse than none.
  const readme = readFileSync(join(ROOT, "README.md"), "utf8")
  for (const name of Object.keys(COMMANDS)) {
    assert.ok(readme.includes(`/${name}`), `README.md must mention /${name}`)
  }
  const shipped = readFileSync(join(ROOT, "package.json"), "utf8")
  assert.ok(JSON.parse(shipped).files.includes("docs"), "docs/ must be published so the context system is documented for users")
})