// Epic D -- Notifications for parallel sessions.
//
//   US-11  a desktop notification when a session finishes or errors
//   US-12  a notification when a question is asked
//
// Delivery is INJECTED. src/plugins/notify.ts takes an optional third argument,
// a `deliver` seam, and this suite supplies a recording sender. Nothing here
// spawns a helper, touches a desktop daemon, opens an SSH hop, or waits: the
// tests observe that a notification WOULD be delivered, which is the only part
// of the contract that is a decision rather than a pipe.
//
// One test deliberately does NOT use the seam (US-11, delivery failure): it
// points OC_NOTIFY_HELPER at a script that exits non-zero, so the real spawn
// path and its exit-code handling are exercised for real.

import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, cleanupAll, scratch, settle, stubInput } from "./_harness.mjs"

test.after(cleanupAll)

const { notifyHooks } = await import(join(ROOT, "src", "plugins", "notify.ts"))

/**
 * A notifier wired to a recording sender.
 *
 * `sent` is the list a real desktop would have received; `result` controls what
 * the sender reports back, so the "delivery failed vs delivered" bookkeeping is
 * observable too.
 */
const notifier = async ({ sessions = {}, result = { ok: true } } = {}) => {
  const stub = stubInput({ sessions })
  const sent = []
  const hooks = await notifyHooks(
    stub.input,
    undefined,
    {
      deliver: async (title, message, urgency) => {
        sent.push({ title, message, urgency })
        return typeof result === "function" ? result() : result
      },
    },
  )
  return { stub, sent, hooks, emit: (type, properties) => hooks.event({ event: { type, properties } }) }
}

const busy = (emit, sessionID) => emit("session.status", { sessionID, status: { type: "busy" } })
const idle = (emit, sessionID) => emit("session.idle", { sessionID })

// ---------------------------------------------------------------------------
// US-11 -- a session finishing
// ---------------------------------------------------------------------------

test("[US-11] a session that went busy and is now idle delivers a done notification", async () => {
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Fix the login redirect" } } })
  await busy(emit, "s1")
  await idle(emit, "s1")
  await settle()

  assert.equal(sent.length, 1, `exactly one notification, got ${JSON.stringify(sent)}`)
  assert.match(sent[0].title, /Fix the login redirect/, "the notification must name the session")
  assert.match(sent[0].message, /finished/i, "the message must say the turn is done")
  assert.equal(sent[0].urgency, "normal", "a routine completion must not escalate to a modal")
})

test("[US-11] an error is delivered and bypasses the duplicate-suppression cooldown", async () => {
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Build the API" } } })
  await busy(emit, "s1")
  // Two errors inside the 5s cooldown window. A cooldown would swallow the
  // second, and a user who never learns the run failed is the exact harm.
  await emit("session.error", { sessionID: "s1" })
  await emit("session.error", { sessionID: "s1" })
  await settle()

  assert.equal(sent.length, 2, `both errors must be announced, got ${JSON.stringify(sent)}`)
  for (const notice of sent) {
    assert.match(notice.message, /Failed/i, `an error notification must say so: ${notice.message}`)
    assert.equal(notice.urgency, "critical", "a failure is the one thing worth interrupting for")
  }
})

test("[US-11] a session that never went busy delivers nothing when it idles", async () => {
  // A session that was created and immediately idled is an empty shell. Notifying
  // for it trains the user to dismiss notifications without reading them.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "scratch" } } })
  await idle(emit, "s1")
  await settle()
  assert.deepEqual(sent, [], "an empty session must not announce finished work")
})

test("[US-11] a subagent session and a cartographer session are both suppressed", async () => {
  const child = await notifier({ sessions: { c1: { id: "c1", parentID: "root", title: "explore-fast" } } })
  await busy(child.emit, "c1")
  await idle(child.emit, "c1")
  await settle()
  assert.deepEqual(child.sent, [], "a subagent going idle is not a thing the user asked for")

  // The cartographer is spawned with no parentID, so structure alone cannot
  // exclude it; it is identified by its title prefix.
  const cartographer = await notifier({ sessions: { m1: { id: "m1", title: "context-manager (auto update)" } } })
  await busy(cartographer.emit, "m1")
  await idle(cartographer.emit, "m1")
  await settle()
  assert.deepEqual(cartographer.sent, [], "the cartographer's own bookkeeping is not finished work")
})

test("[US-11] a helper that exits non-zero is reported as a failed delivery, not as sent", async () => {
  // No seam here on purpose: this drives the REAL spawn path and its exit-code
  // handling, because the bug this guards against was a log line reading
  // "notified" while nothing reached the desktop.
  const bin = scratch("failing-helper-")
  const helper = join(bin, "oc-notify")
  writeFileSync(helper, "#!/bin/sh\nexit 1\n")
  chmodSync(helper, 0o755)
  const previous = process.env.OC_NOTIFY_HELPER
  process.env.OC_NOTIFY_HELPER = helper
  try {
    const stub = stubInput({ sessions: { s1: { id: "s1", title: "Something" } } })
    const hooks = await notifyHooks(stub.input)
    await hooks.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } } })
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    await settle(120)

    const text = stub.text()
    assert.ok(text.some((line) => line.startsWith("error notification failed")), `a failed send must not be logged as sent:\n${text.join("\n")}`)
    assert.ok(!text.some((line) => line.startsWith("info notified")), `claiming "notified" on a failed send is the bug:\n${text.join("\n")}`)
  } finally {
    if (previous === undefined) delete process.env.OC_NOTIFY_HELPER
    else process.env.OC_NOTIFY_HELPER = previous
  }
})

test("[US-11] a sender that reports failure is never recorded as a delivery", async () => {
  const { stub, sent, emit } = await notifier({
    sessions: { s1: { id: "s1", title: "Something" } },
    result: { ok: false, detail: "helper exit 1" },
  })
  await busy(emit, "s1")
  await idle(emit, "s1")
  await settle()

  assert.equal(sent.length, 1, "the notification was attempted")
  const text = stub.text()
  assert.ok(text.some((line) => line.startsWith("error notification failed")), `must be reported as failed:\n${text.join("\n")}`)
  assert.ok(!text.some((line) => line.startsWith("info notified")), "a failed send must never read as notified")
})

// ---------------------------------------------------------------------------
// US-12 -- a question
// ---------------------------------------------------------------------------

test("[US-12] a question delivers a notification carrying the question's own text", async () => {
  // The text is the difference between a notification you can answer from and
  // one you have to open a terminal for.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
  await busy(emit, "s1")
  await emit("question.asked", {
    sessionID: "s1",
    questions: [{ question: "Should the migration be reversible, or one-way?" }],
  })
  await settle()

  assert.equal(sent.length, 1, `expected exactly one question notification, got ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /reversible/, `the question text must be included: ${sent[0].message}`)
  assert.match(sent[0].message, /Awaiting your response/i, `the message must say why you are being interrupted`)
  assert.equal(sent[0].urgency, "normal", "a question is a request, not a failure, and must not go modal")
})

test("[US-12] the idle event after a parked question sends no duplicate finished notification", async () => {
  // Nothing finished: the task is parked waiting on the user. Saying "finished"
  // there is actively wrong, not merely redundant.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
  await busy(emit, "s1")
  await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
  await idle(emit, "s1")
  await settle()

  assert.equal(sent.length, 1, `the parked session must notify once, not twice: ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /Awaiting your response/, "the only notification is the question")
})

test("[US-12] a parked question is cleared by a reply, a rejection, or an error", async () => {
  // Each of these unblocks the session. If `pending` survived any of them, every
  // later real completion for that session would be silently suppressed.
  for (const [event, label] of [
    ["question.replied", "replied"],
    ["question.rejected", "rejected"],
    ["session.error", "errored"],
  ]) {
    const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
    await busy(emit, "s1")
    await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
    await settle()
    sent.length = 0

    await emit(event, { sessionID: "s1" })
    await settle()
    await idle(emit, "s1")
    await settle()

    // The criterion is that the pending entry is GONE: whatever unblocked the
    // session, the next real completion must announce itself rather than being
    // silently swallowed as "still waiting for you".
    const completions = sent.filter((notice) => /finished/i.test(notice.message))
    assert.equal(completions.length, 1, `${label}: the next real completion must notify again, got ${JSON.stringify(sent)}`)
    if (event === "session.error") {
      assert.ok(sent.some((n) => /Failed/i.test(n.message)), `${label}: the error itself must be announced, got ${JSON.stringify(sent)}`)
    }
  }
})

test("[US-12] a question and a completion inside one cooldown window are not deduplicated against each other", async () => {
  // They are different moments and different things to act on. A shared key
  // would let the second one vanish because the first one just fired.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
  await busy(emit, "s1")
  await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
  await emit("question.replied", { sessionID: "s1" })
  await idle(emit, "s1")
  await settle()

  assert.equal(sent.length, 2, `both moments must be announced, got ${JSON.stringify(sent)}`)
  assert.match(sent[0].message, /Awaiting your response/)
  assert.match(sent[1].message, /finished/i, "the completion must not be swallowed by the question's cooldown")
})

test("[US-12] a session deleted mid-question stops contributing to later notifications", async () => {
  // Bounded state in a long-running server: a deleted session must not keep a
  // pending question parked forever.
  const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Add a migration" } } })
  await busy(emit, "s1")
  await emit("question.asked", { sessionID: "s1", questions: [{ question: "Reversible?" }] })
  await settle()
  await emit("session.deleted", { info: { id: "s1" } })
  sent.length = 0

  await busy(emit, "s1")
  await idle(emit, "s1")
  await settle()
  assert.equal(sent.length, 1, "the re-created session must notify on its own real work")
  assert.match(sent[0].message, /finished/i, "it must not still read as awaiting a response to the old question")
})

test("[US-11] a remote session says so in the notification, so the tunnel is expected", async () => {
  const previous = { client: process.env.SSH_CLIENT, tty: process.env.SSH_TTY }
  process.env.SSH_CLIENT = "10.0.0.1 5555 10.0.0.2 22"
  try {
    const { sent, emit } = await notifier({ sessions: { s1: { id: "s1", title: "Remote work" } } })
    await busy(emit, "s1")
    await idle(emit, "s1")
    await settle()
    assert.equal(sent.length, 1)
    assert.match(sent[0].message, /\(remote\)/, `a remote session must be recognisable in its own notification: ${sent[0].message}`)
  } finally {
    if (previous.client === undefined) delete process.env.SSH_CLIENT
    else process.env.SSH_CLIENT = previous.client
    if (previous.tty === undefined) delete process.env.SSH_TTY
    else process.env.SSH_TTY = previous.tty
  }
})