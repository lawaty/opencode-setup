import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, "..", "plugins", "notify.ts")
const LIB = join(HERE, "..", "lib", "notify.ts")

let passed = 0
const failures = []

const check = async (name, fn) => {
  try {
    await fn()
    passed++
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const { Notifier, notifyMessage, safeTitle, shouldNotify } = await import(LIB)
const { Notify } = await import(PLUGIN)

// ---------------------------------------------------------------------------
// Policy: what is worth notifying about
// ---------------------------------------------------------------------------

await check("a finished root session notifies with its title", () => {
  const decision = shouldNotify({
    info: { id: "s1", title: "Fix the login redirect" },
    outcome: "done",
    sawMessage: true,
  })
  assert(decision.notify, "a root session that did work should notify")
  assert(decision.title.includes("Fix the login redirect"), `title should name the session: ${decision.title}`)
  assert(decision.urgency === "normal", "success should be normal urgency")
})

await check("subagents are suppressed", () => {
  // The requirement the whole plugin exists to satisfy: one notification per
  // thing the user asked for, not one per delegated child.
  const decision = shouldNotify({
    info: { id: "child", parentID: "root", title: "explore-fast" },
    outcome: "done",
    sawMessage: true,
  })
  assert(!decision.notify, "a subagent must not notify")
  assert(decision.reason === "subagent", `reason should say subagent, got ${decision.reason}`)
})

await check("the cartographer session is suppressed", () => {
  // context-autoupdate creates it with no parentID, so structure alone cannot
  // exclude it. Without this, every file edit would announce the map update.
  const decision = shouldNotify({
    info: { id: "cm", title: "context-manager (auto update)" },
    outcome: "done",
    sawMessage: true,
  })
  assert(!decision.notify, "the internal cartographer must not notify")
})

await check("a compaction is not a finished task", () => {
  const decision = shouldNotify({
    info: { id: "s1", title: "Long refactor", time: { compacting: 12345 } },
    outcome: "done",
    sawMessage: true,
  })
  assert(!decision.notify, "compacting is mid-conversation, not completion")
  assert(decision.reason === "compacting", `reason should say compacting, got ${decision.reason}`)
})

await check("an untouched session does not notify", () => {
  const decision = shouldNotify({ info: { id: "s1", title: "New" }, outcome: "done", sawMessage: false })
  assert(!decision.notify, "an empty session is not finished work")
})

await check("a critical notification bypasses the cooldown", async () => {
  // The cooldown stops a burst of identical "ready" notices. It must not swallow
  // a failure: a session can error moments after it went busy, while the
  // cooldown from the transition is still holding.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })
  const client = {
    logs: [],
    app: { log: async () => {} },
    session: { get: async () => ({ data: { id: "r", title: "Deploy" } }) },
  }
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  // A "ready" inside the window, then an error inside the same window.
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "r", status: { type: "busy" } } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "r" } } })
  await new Promise((resolve) => setTimeout(resolve, 500))
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "r" } } })
  await new Promise((resolve) => setTimeout(resolve, 700))

  const lines = (existsSync(sent) ? readFileSync(sent, "utf8") : "").trim().split("\n").filter(Boolean)
  assert(lines.length === 2, `expected ready + error, got ${lines.length}: ${JSON.stringify(lines)}`)
  assert(lines[1].includes("critical"), `the error should be critical: ${lines[1]}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("an error notifies at critical urgency", () => {
  const decision = shouldNotify({
    info: { id: "s1", title: "Deploy run" },
    outcome: "error",
    detail: "rate limited",
  })
  assert(decision.notify, "an error should notify even without a prior turn")
  assert(decision.urgency === "critical", "an error should be critical")
  assert(notifyMessage("error", "rate limited").includes("rate limited"), "the detail should be included")
})

await check("a missing session id never notifies", () => {
  assert(!shouldNotify({ info: undefined, outcome: "done" }).notify, "no info, no notification")
  assert(!shouldNotify({ info: {}, outcome: "done" }).notify, "no id, no notification")
})

// ---------------------------------------------------------------------------
// Title hygiene: session titles are user text that lands in a notification
// ---------------------------------------------------------------------------

await check("control characters are stripped from titles", () => {
  const title = safeTitle("Fix\u0007 the \u001b[31mredirect\u0000")
  // eslint-disable-next-line no-control-regex
  assert(!/[\u0000-\u001f\u007f]/.test(title), `control characters survived: ${JSON.stringify(title)}`)
  assert(title.includes("Fix the"), `text should be preserved: ${JSON.stringify(title)}`)
})

await check("long titles are truncated for the desktop", () => {
  const title = safeTitle("x".repeat(400))
  assert(title.length <= 90, `expected a cap near 90, got ${title.length}`)
  assert(title.endsWith("…"), "truncation should be visible")
})

await check("an empty or missing title still yields something usable", () => {
  assert(safeTitle(undefined) === "session", "undefined should fall back")
  assert(safeTitle("   ") === "session", "whitespace should fall back")
})

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

await check("cooldown suppresses a rapid second notification", () => {
  const notifier = new Notifier(5_000)
  assert(notifier.allow("s1", 1_000), "the first should be allowed")
  assert(!notifier.allow("s1", 2_000), "a second inside the window should be suppressed")
  assert(notifier.allow("s1", 7_000), "one past the window should be allowed again")
})

await check("cooldown is per session", () => {
  const notifier = new Notifier(5_000)
  assert(notifier.allow("s1", 1_000), "s1 first")
  assert(notifier.allow("s2", 1_100), "a different session is unaffected")
})

await check("the rate limiter bounds its bookkeeping", () => {
  const notifier = new Notifier(1_000)
  for (let i = 0; i < 600; i++) notifier.allow(`session-${i}`, i)
  // Old entries must be evicted rather than growing for the life of the process.
  assert(notifier.lastSentSize() <= 500, `expected eviction, size is ${notifier.lastSentSize()}`)
})

// ---------------------------------------------------------------------------
// The plugin wiring
// ---------------------------------------------------------------------------

const pluginSrc = readFileSync(PLUGIN, "utf8")

await check("the plugin exports exactly one binding", () => {
  // opencode calls every export of every plugins/ file and uses the return value
  // as its hooks object, so a second export is a second broken plugin.
  const exports = [...pluginSrc.matchAll(/^export (?:const|function|class|default)\s+(\w+)/gm)].map((m) => m[1])
  assert(exports.length === 1, `expected 1 export, found ${exports.length}: ${exports.join(", ")}`)
  assert(exports[0] === "Notify", `unexpected export name ${exports[0]}`)
})

await check("the plugin defers to the tested tunnel helper", () => {
  // A second notification implementation in TypeScript is a second thing to get
  // wrong; oc-notify is the one already verified against both hosts.
  assert(/oc-notify/.test(pluginSrc), "should locate the oc-notify helper")
  assert(!/notify-send/.test(pluginSrc), "should not call notify-send directly")
})

await check("the plugin passes argv, not a shell string", () => {
  assert(/spawn\(helper, \[/.test(pluginSrc), "should spawn the helper with an argv array")
  assert(!/exec\(/.test(pluginSrc), "should not build a shell command string")
})

await check("the notification helper is detached", () => {
  assert(/detached: true/.test(pluginSrc), "a notification must not hold the server open")
  assert(/unref\(\)/.test(pluginSrc), "the child should be unreferenced")
})

await check("a missing helper warns once, never throws", () => {
  assert(/warnedHelper/.test(pluginSrc), "should remember that it already warned")
  assert(/no oc-notify helper found/.test(pluginSrc), "should say what is missing")
})

await check("the plugin is registered by directory, not config", async () => {
  // plugins/*.ts is auto-discovered, so no opencode.jsonc entry is needed. This
  // asserts the file is where discovery will find it.
  assert(existsSync(PLUGIN), "plugins/notify.ts should exist")
})

// ---------------------------------------------------------------------------
// End to end against the plugin's event handler
// ---------------------------------------------------------------------------

const makeClient = (sessions) => {
  const logs = []
  return {
    logs,
    app: { log: async ({ body }) => logs.push(`${body.level} ${body.message}`) },
    session: {
      get: async ({ path: { id } }) => {
        const info = sessions[id]
        if (!info) return { error: { name: "NotFound" } }
        return { data: info }
      },
    },
  }
}

await check("the handler notifies for a root session and ignores a child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  // A stub helper so the handler's spawn target exists and we can observe calls.
  const sent = join(dir, "sent.log")
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })
  mkdirSync(dir, { recursive: true })

  const sessions = {
    root: { id: "root", title: "Fix the login redirect" },
    child: { id: "child", parentID: "root", title: "explore-fast" },
  }
  const client = makeClient(sessions)
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  const busy = { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } }
  await hooks.event({ event: busy })
  await hooks.event({ event: { type: "session.updated", properties: { info: sessions.root } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "root" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "child" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const lines = existsSync(sent) ? readFileSync(sent, "utf8").trim().split("\n").filter(Boolean) : []
  assert(lines.length === 1, `expected exactly one notification, got ${lines.length}: ${JSON.stringify(lines)}`)
  assert(lines[0].includes("Fix the login redirect"), `notification should name the session: ${lines[0]}`)
  assert(!lines[0].includes("explore-fast"), "the subagent must not appear")

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("an idle event with no prior work does not notify", async () => {
  // An opened-but-unused session idles too. Without the busy marker every
  // launch of opencode would announce an empty session.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })
  const sessions = { idle: { id: "idle", title: "New" } }
  const client = makeClient(sessions)
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "idle" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const body = existsSync(sent) ? readFileSync(sent, "utf8") : ""
  assert(body === "", `expected no notification, got: ${body}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("a title seen before the idle event is used as a fallback", async () => {
  // session.get can be the slower of the two; the plugin keeps the last title it
  // saw so the notification still names the session.
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const sent = join(dir, "sent.log")
  const helper = join(dir, "oc-notify")
  writeFileSync(helper, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${sent}\n`, { mode: 0o755 })
  const client = {
    logs: [],
    app: { log: async () => {} },
    // Returns an id but no title: the fallback has to carry it.
    session: { get: async () => ({ data: { id: "r" } }) },
  }
  const hooks = await Notify({ client, directory: dir })
  process.env.OC_NOTIFY_HELPER = helper

  await hooks.event({ event: { type: "session.updated", properties: { info: { id: "r", title: "Named by event" } } } })
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "r", status: { type: "busy" } } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "r" } } })
  await new Promise((resolve) => setTimeout(resolve, 600))

  const body = existsSync(sent) ? readFileSync(sent, "utf8") : ""
  assert(body.includes("Named by event"), `expected the cached title, got: ${body}`)

  delete process.env.OC_NOTIFY_HELPER
  rmSync(dir, { recursive: true, force: true })
})

await check("the handler swallows a session.get failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-"))
  const client = {
    logs: [],
    app: { log: async () => {} },
    session: { get: async () => { throw new Error("boom") } },
  }
  const hooks = await Notify({ client, directory: dir })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "nope" } } })
  assert(true, "a failed lookup must not throw out of the handler")
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

console.log(`${passed} checks passed`)
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}