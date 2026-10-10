// Notification policy for plugins/notify.ts: which session transitions are worth
// a desktop notification, and what it should say.
//
// This is lib/, not plugins/, for the same reason lib/writer-rule.ts is: opencode
// treats every export of a file in plugins/ as a plugin and calls it with the
// plugin input, then uses the return value as its hooks object. A plain helper
// exported from there is invoked with the wrong arguments and poisons the hook
// registry, which stops the process starting.
//
// Everything here is pure so the policy can be tested without a running server.

const INTERNAL_TITLE_PREFIXES = [
  // context-autoupdate spawns the cartographer through the session API, with no
  // parentID, so it looks exactly like a root session going idle. Notifying for
  // it would announce the cartographer's own bookkeeping as a finished task.
  "context-manager (auto",
]

// The three things worth interrupting someone for. Wording is deliberately about
// what *they* must do, not about what opencode did: a notification is only
// actionable if the reader can tell, in one line, whether they are the bottleneck.
//
// "Finished" is deliberately not "session finished". The session is still open --
// this is the agent handing control back, and saying "session ended" implies the
// work is over and the conversation closed, which is neither true nor useful.
export const NOTIFY_OUTCOMES = ["done", "question", "error"] as const
export type Outcome = (typeof NOTIFY_OUTCOMES)[number]

export const notifyMessage = (outcome: Outcome, detail?: string) => {
  if (outcome === "error") return detail ? `Failed — ${detail}` : "Failed"
  // The question's own text is appended when known. It is the difference between a
  // notification you must open a terminal to act on and one you can answer from
  // the notification itself, which is the whole reason to interrupt someone.
  if (outcome === "question") return detail ? `Awaiting your response — ${detail}` : "Awaiting your response"
  return "Task finished, waiting for your review"
}

export type SessionInfo = {
  id?: string
  parentID?: string
  title?: string
  time?: { compacting?: number }
}

export type Decision = { notify: true; title: string; message: string; urgency: "normal" | "critical" } | { notify: false; reason: string }

// A session title is user-visible text that lands in a notification, so it is
// stripped of control characters and length-capped rather than trusted.
export const safeTitle = (raw: string | undefined, fallback = "session") => {
  if (!raw) return fallback
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  if (!clean) return fallback
  return clean.length > 90 ? `${clean.slice(0, 89)}…` : clean
}

// Why a given session transition should not raise a notification.
export const shouldNotify = (input: {
  info: SessionInfo | undefined
  outcome: Outcome
  detail?: string
  // A session created but never prompted is an empty shell, not finished work.
  sawMessage?: boolean
  // An unanswered question is outstanding in this session. Suppresses the
  // redundant "finished" that the idle event raises right after a question.
  awaitingResponse?: boolean
}): Decision => {
  const { info, outcome, detail } = input

  if (!info?.id) return { notify: false, reason: "no session info" }

  // Subagents. This is the suppression the whole design turns on: every
  // explore-fast/implement-fast child session idles when it finishes, and a
  // session that dispatched ten of them would otherwise announce ten "ready"
  // notifications for work the user never asked about individually.
  if (info.parentID) return { notify: false, reason: "subagent" }

  const title = safeTitle(info.title)

  if (INTERNAL_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))) {
    return { notify: false, reason: "internal session" }
  }

// Compaction rewrites history and idles the session, but no task finished:
  // the user is still mid-conversation. Sending "ready for you" here would
  // train them to dismiss the notification without reading it.
  if (info.time?.compacting) return { notify: false, reason: "compacting" }

  if (outcome === "done" && input.sawMessage === false) {
    return { notify: false, reason: "no work done" }
  }

  // A session blocked on a question has already told them. The idle event that
  // follows the question would otherwise fire a second notification for the same
  // blocked moment, and "task finished" is actively wrong there -- nothing
  // finished, the task is parked waiting on them.
  if (outcome === "done" && input.awaitingResponse) {
    return { notify: false, reason: "awaiting your response" }
  }

  // A question is a request for the user, not a failure, so it is not critical:
  // critical urgency escalates to a modal on most desktops, and this is a routine
  // part of working with an agent.
  return {
    notify: true,
    title: `opencode — ${title}`,
    message: notifyMessage(outcome, detail),
    urgency: outcome === "error" ? "critical" : "normal",
  }
}

// A question can span several entries, and the notification should name the one
// that is actually blocking. Long questions are truncated rather than wrapped:
// this is a one-line desktop summary, and the full text is in the terminal.
export const questionHeadline = (questions: Array<{ question?: string }> | undefined) => {
  const first = questions?.find((entry) => typeof entry?.question === "string" && entry.question.trim())
  if (!first?.question) return ""
  const clean = safeTitle(first.question)
  return clean.length > 70 ? `${clean.slice(0, 69)}…` : clean
}

// Rate limit. A root session can idle more than once in quick succession (a
// queued message, a retry, an abort), and a burst of identical notifications is
// worse than none. One per session per window.
const MAX_TRACKED = 500

export class Notifier {
  private readonly lastSent = new Map<string, number>()
  // Not a constructor parameter property: this module is loaded by node's
  // type-stripping loader, which does not support the shorthand.
  private readonly windowMs: number

  constructor(windowMs: number) {
    this.windowMs = windowMs
  }

  allow(sessionID: string, now: number) {
    const previous = this.lastSent.get(sessionID)
    if (previous !== undefined && now - previous < this.windowMs) return false
    this.record(sessionID, now)
    return true
  }

  // Record without asking. Used by the error path, which must bypass the window
  // rather than be blocked by it, but still needs the timestamp refreshed.
  record(sessionID: string, now: number) {
    this.lastSent.set(sessionID, now)
    this.evict(now)
  }

  private evict(now: number) {
    if (this.lastSent.size <= MAX_TRACKED) return
    // Drop oldest-first, not oldest-that-happens-to-be-expired: a burst of
    // sessions inside one window would otherwise all be "too recent" and the map
    // would keep growing, which is the exact leak this bound exists for. Map
    // preserves insertion order, and insertion order is send order.
    let excess = this.lastSent.size - MAX_TRACKED
    for (const key of this.lastSent.keys()) {
      if (excess-- <= 0) break
      this.lastSent.delete(key)
    }
  }

  // Exposed so the eviction test can assert on it: the map is otherwise
  // unreachable from outside, which would make the bound untestable.
  lastSentSize() {
    return this.lastSent.size
  }
}