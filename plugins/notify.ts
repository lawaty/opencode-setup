import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { Notifier, shouldNotify, type SessionInfo } from "../lib/notify.ts"

// Desktop notification when a session finishes, so a long task does not need a
// watched terminal.
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

  const deliver = (title: string, message: string, urgency: string) =>
    new Promise<void>((resolve) => {
      const helper = findHelper()
      if (!helper) {
        if (!warnedHelper) {
          warnedHelper = true
          void log("warn", "no oc-notify helper found; run 'bin/oc-sync' to install one")
        }
        resolve()
        return
      }
      // Detached and unref'd: a notification must never hold the server open,
      // and a failed helper must not surface as an unhandled rejection.
      const child = spawn(helper, [title, message, urgency, "utilities-terminal"], {
        stdio: "ignore",
        detached: true,
      })
      child.on("error", (error) => void log("warn", `notification helper failed: ${String(error)}`))
      child.unref()
      resolve()
    })

  const announce = async (sessionID: string, outcome: "done" | "error", detail?: string) => {
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
      })
      if (!decision.notify) {
        void log("debug", `suppressed: ${decision.reason}`, { sessionID })
        return
      }
      // The cooldown exists to stop a burst of identical "ready" notices. It must
      // not swallow a failure: a session that just errored has not been reported,
      // and the cooldown can still be holding from the "busy" transition moments
      // earlier. Errors bypass it, and refresh it so a follow-up error is not
      // deduplicated against the failure the user just saw.
      const now = Date.now()
      if (decision.urgency !== "critical" && !notifier.allow(sessionID, now)) {
        void log("debug", "suppressed: cooldown", { sessionID })
        return
      }
      if (decision.urgency === "critical") notifier.record(sessionID, now)
      const message = isRemote ? `${decision.message} (remote)` : decision.message
      await deliver(decision.title, message, decision.urgency)
      void log("info", "notified", { sessionID, outcome, title: decision.title })
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

        if (event.type === "session.error") {
          const sessionID = event.properties.sessionID
          if (sessionID) void announce(sessionID, "error")
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