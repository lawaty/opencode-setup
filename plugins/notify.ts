import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { Notifier, questionHeadline, shouldNotify, type Outcome, type SessionInfo } from "../lib/notify.ts"

// Desktop notification when a session needs you: a finished turn, or a question
// it cannot proceed without.
//
// Two design points that are load-bearing rather than cosmetic:
//
//   * Subagents are suppressed. A root session that dispatched ten
//     explore-fast children would otherwise raise ten "ready" notifications.
//     The whole value of this plugin is one notification per thing you asked
//     for, and a subagent going idle is not a thing you asked for.
//   * The cartographer is suppressed too. context-autoupdate creates it through
//     the session API with no parentID, so it is indistinguishable from a root
//     session by structure alone; it is identified by its title prefix.
//
// The notification is delivered by bin/oc-notify, the same tunnel path `oc` uses,
// rather than by talking to a notification daemon from here. One implementation of
// the return trip, already tested against both hosts; a second one written in
// TypeScript would be a second thing to get wrong.
//
// Two outcomes are worth someone's attention, and the wording is about what they
// must do rather than what opencode did:
//
//   done      the agent finished a turn and handed control back
//   question  the agent is blocked on an answer and cannot continue
//
// Both are suppressed for subagents and the cartographer. A session.started
// notification was removed: it interrupts to say nothing, and it fires before
// there is any result to name.
//
// This module must export the plugin and nothing else -- see lib/writer-rule.ts
// for why a stray export from plugins/ breaks the whole process.

const SERVICE = "notify"
const COOLDOWN_MS = 5_000

// Where the notification helper lives. The repo copy is the source of truth; a
// deploy puts one in ~/bin. Checked in that order so a host that has been
// oc-synced uses its own, and this machine still works without a sync.
const findHelper = (): string | undefined => {
  const candidates = [
    process.env.OC_NOTIFY_HELPER,
    path.join(process.env.HOME ?? "", "bin", "oc-notify"),
    path.join((import.meta as { dir?: string }).dir ?? "", "oc-notify"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

export const Notify = (async ({ client, directory }) => {
  const notifier = new Notifier(COOLDOWN_MS)
  // Sessions this process has actually seen do work in. Distinguishes "finished
  // after a turn" from "an idle event for a session that was merely opened".
  const active = new Set<string>()
  // Latest known title per session. session.get is the authority and is always
  // consulted before notifying; this exists so an idle event racing the title
  // update still names the session rather than falling back to "session".
  const titles = new Map<string, string | undefined>()
  // Sessions with an unanswered question outstanding. A question parks the turn:
  // the user has been asked and the task cannot continue, which is a different
  // (and more urgent) reason to look than "finished". Tracked so the idle event
  // that follows a question does not also claim the task finished.
  const pending = new Set<string>()
  let warnedHelper = false

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: SERVICE, level, message, extra } }).catch(() => {})

  const fetchInfo = async (sessionID: string) => {
    const info = await client.session
      .get({ path: { id: sessionID }, query: { directory } })
      .then((result) => result.data as SessionInfo | undefined)
      .catch(() => undefined)
    return info
  }

// A notification that fails to arrive is worse than one that never fired: the
  // user believes the agent finished and stops watching. So delivery is verified,
  // not assumed -- the helper's exit status and stderr are captured and logged, and
  // "notified" is only claimed when the helper actually succeeded.
  const deliver = (title: string, message: string, urgency: string) =>
    new Promise<{ ok: boolean; detail?: string }>((resolve) => {
      const helper = findHelper()
      if (!helper) {
        if (!warnedHelper) {
          warnedHelper = true
          void log("warn", "no oc-notify helper found; run 'bin/oc-sync' to install one")
        }
        resolve({ ok: false, detail: "no oc-notify helper found" })
        return
      }
      // Detached and unref'd: a notification must never hold the server open.
      // stdio pipes (not ignore) because the helper's own diagnostics are the only
      // way a remote tunnel failure is ever visible -- oc-notify prints to stderr
      // and exits 0, so its output is the entire signal.
      const child = spawn(helper, [title, message, urgency, "utilities-terminal"], {
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      })
      let stderr = ""
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 400) stderr += String(chunk)
      })
      child.on("error", (error) => {
        void log("warn", `notification helper failed: ${String(error)}`, { title })
        resolve({ ok: false, detail: String(error) })
      })
      child.on("exit", (code) => {
        const noise = stderr.trim()
        // Two independent signals, because each has failed on its own: the helper's
        // exit code, and any text it wrote to stderr.
        //
        // The exit code is primary -- oc-notify propagates send_notify's status, and
        // the hop's real failure (ssh's "Permission denied (publickey,password)")
        // is a bare non-zero exit from ssh, which the tunnel's LogLevel=ERROR hides.
        // Matching on stderr text alone missed exactly that case and logged a
        // failed delivery as sent. Stderr is still treated as a failure, because a
        // successful send is silent and there is nothing benign for it to print.
        const ok = code === 0 && noise === ""
        if (!ok) {
          void log("warn", `notification not delivered: ${noise || `helper exit ${code}`}`, {
            title,
            message,
          })
        }
        resolve({ ok, detail: noise || undefined })
      })
      child.unref()
    })

  const announce = async (sessionID: string, outcome: Outcome, detail?: string) => {
    try {
      const info = await fetchInfo(sessionID)
      if (!info) {
        void log("debug", "session info unavailable; not notifying", { sessionID })
        return
      }
      // session.get is authoritative, but an idle event can arrive before the
      // title update lands; fall back to the last title this process saw rather
      // than announcing "session".
      const titled = info.title ? info : { ...info, title: titles.get(sessionID) }
      // isRemote mirrors what bin/oc decides for itself, so the message says the
      // useful thing: a remote session needs the tunnel, a local one does not.
      const isRemote = Boolean(process.env.SSH_CLIENT || process.env.SSH_TTY)
      const decision = shouldNotify({
        info: titled,
        outcome,
        detail,
        sawMessage: active.has(sessionID),
        awaitingResponse: pending.has(sessionID),
      })
      if (!decision.notify) {
        void log("debug", `suppressed: ${decision.reason}`, { sessionID })
        return
      }
      // The cooldown absorbs a burst of identical notices. Two outcomes are
      // exempt, for the same reason: they report a session that is BLOCKED, and a
      // blocked session that is not announced is a silent stall.
      //   error    the failure is new; the cooldown may still be holding from the
      //            "busy" transition moments earlier
      //   question a second question within the window is a second thing to answer,
      //            not a repeat of the first -- gating it strands the user on a
      //            prompt they were never told about
      // Both record the timestamp so a follow-up is judged against what the user
      // has actually already seen.
      //
      // Keyed per outcome so a genuine later completion still notifies: a question
      // and the "finished" that follows it are different moments.
      const kind = decision.urgency === "critical" ? "error" : outcome === "question" ? "question" : "done"
      const key = `${kind}:${sessionID}`
      const blocking = kind === "error" || kind === "question"
      const now = Date.now()
      if (blocking) {
        notifier.record(key, now)
      } else if (!notifier.allow(key, now)) {
        void log("debug", "suppressed: cooldown", { sessionID })
        return
      }
      const message = isRemote ? `${decision.message} (remote)` : decision.message
      const sent = await deliver(decision.title, message, decision.urgency)
      // Claiming "notified" on a failed delivery is how this bug survived: the log
      // said notified five times while nothing reached the desktop. Only say it when
      // the helper confirmed, and say what failed when it did not.
      void log(sent.ok ? "info" : "error", sent.ok ? "notified" : "notification failed", {
        sessionID,
        outcome,
        title: decision.title,
        ...(sent.detail ? { detail: sent.detail } : {}),
      })
    } catch (error) {
      void log("error", `notify failed: ${String(error)}`)
    }
  }

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "session.status") {
          // busy is the reliable "work is happening" signal. session.updated also
          // fires on a title change or a token-count refresh, which would mark a
          // session as active without any work having been done.
          const { sessionID, status } = event.properties
          if (status.type === "busy" && sessionID) active.add(sessionID)
          return
        }

        if (event.type === "session.updated") {
          // A title arrives here, and the notification is named after it, so
          // capture the latest. Not the marker of "work happened" -- see above.
          const info = event.properties.info as SessionInfo | undefined
          if (info?.id) titles.set(info.id, info.title)
          return
        }

        // question.asked is not in the pinned SDK's event types -- the runtime emits it
        // (verified against a live server) but types.gen.d.ts predates it. Reading
        // it off the event object is deliberate: the alternative is a plugin that
        // cannot see the most important thing an agent can do to you.
        if (event.type === "question.asked") {
          const properties = event.properties as {
            sessionID?: string
            questions?: Array<{ question?: string }>
          }
          const sessionID = properties?.sessionID
          if (!sessionID) return
          pending.add(sessionID)
          // A question is also proof of work, so it must not be suppressed by the
          // never-went-busy rule -- and if it was never seen busy, treat it as busy.
          active.add(sessionID)
          const headline = questionHeadline(properties.questions)
          void announce(sessionID, "question", headline || undefined)
          return
        }

        // The question was answered OR dismissed -- `rejected` is what the runtime
        // emits when it is dropped rather than answered, and it is the path that
        // would otherwise leave `pending` set forever, silently suppressing every
        // later "Task finished" for that session.
        //
        // Both are read off the wire rather than from the pinned types, for the same
        // reason as question.asked: the SDK types here predate these events.
        if (event.type === "question.replied" || event.type === "question.rejected") {
          const sessionID = (event.properties as { sessionID?: string })?.sessionID
          if (sessionID) pending.delete(sessionID)
          return
        }

        if (event.type === "session.error") {
          const sessionID = event.properties.sessionID
          // An error unblocks the session: whatever question was parked is no
          // longer what the user must act on.
          if (sessionID) {
            pending.delete(sessionID)
            void announce(sessionID, "error")
          }
          return
        }

        // Neither `active` nor `titles` may grow for the life of a long-running
        // server, and a deleted session must stop contributing to either.
        if (event.type === "session.deleted") {
          const sessionID = (event.properties as { info?: { id?: string } })?.info?.id
          if (sessionID) {
            active.delete(sessionID)
            titles.delete(sessionID)
            pending.delete(sessionID)
          }
          return
        }

        if (event.type !== "session.idle") return

        const sessionID = event.properties.sessionID
        if (sessionID) void announce(sessionID, "done")
      } catch (error) {
        void log("error", `handler failed: ${String(error)}`)
      }
    },
  }
}) satisfies Plugin