/**
 * What the toolbar badge and the notifications say while the panel is closed
 * (ADR-0228 §4).
 *
 * Pure: the service worker reads the recent list on an alarm or a socket hint
 * and hands it here with what it saw last time; this answers the badge and
 * which submissions just changed in a way worth a notification. The snapshot
 * lives in `chrome.storage.session` because the worker forgets everything
 * between wake-ups, and a worker that forgot would announce every completed
 * task again on each one.
 */
import type {
  BrowserContextSubmissionSummaryV1,
  BrowserSubmissionStatus,
} from "@cognia/companion-client"

export const STATUS_SNAPSHOT_KEY = "cognia.statusSnapshot.v1"

/** Statuses that are still going somewhere without the person. */
const IN_FLIGHT: readonly BrowserSubmissionStatus[] = ["submitting", "queued", "running"]

/** The statuses a notification announces. */
export const ANNOUNCED: readonly BrowserSubmissionStatus[] = ["completed", "failed", "needs_input"]

export interface StatusSnapshot {
  /** Last status seen per submission id. */
  statuses: Record<string, BrowserSubmissionStatus>
  /** False until the first read, which is a baseline and announces nothing. */
  primed: boolean
}

export const EMPTY_SNAPSHOT: StatusSnapshot = { statuses: {}, primed: false }

export interface StatusCounts {
  running: number
  needsInput: number
}

export function countStatuses(items: readonly BrowserContextSubmissionSummaryV1[]): StatusCounts {
  let running = 0
  let needsInput = 0
  for (const item of items) {
    if (IN_FLIGHT.includes(item.status)) running += 1
    else if (item.status === "needs_input") needsInput += 1
  }
  return { running, needsInput }
}

/** Whether the alarm should keep polling: something can still change on its own. */
export function shouldKeepPolling(items: readonly BrowserContextSubmissionSummaryV1[]): boolean {
  return items.some((item) => IN_FLIGHT.includes(item.status) || item.status === "needs_input")
}

export interface Badge {
  text: string
  /** One of the badge's two meanings: attention needed, or work under way. */
  tone: "attention" | "busy" | "none"
}

/**
 * The badge: "!" while a site decision is waiting (the agent is blocked on
 * the person), else the count of tasks waiting for input plus running, with
 * attention tone when any is waiting.
 */
export function badgeFor(counts: StatusCounts, siteQuestions: number): Badge {
  if (siteQuestions > 0) return { text: "!", tone: "attention" }
  const total = counts.running + counts.needsInput
  if (total === 0) return { text: "", tone: "none" }
  return {
    text: total > 99 ? "99+" : String(total),
    tone: counts.needsInput > 0 ? "attention" : "busy",
  }
}

export const BADGE_COLORS: Record<Badge["tone"], string> = {
  attention: "#d97706",
  busy: "#2563eb",
  none: "#00000000",
}

export interface Transition {
  item: BrowserContextSubmissionSummaryV1
  from: BrowserSubmissionStatus | null
  to: BrowserSubmissionStatus
}

/**
 * Submissions that reached an announced status since the snapshot, and the
 * snapshot to store next.
 *
 * A submission first seen already finished is not announced: it finished
 * before this worker was watching (or was submitted from elsewhere and only
 * now paged in). One first seen waiting for input is, because it still needs
 * the person.
 */
export function diffStatuses(
  snapshot: StatusSnapshot,
  items: readonly BrowserContextSubmissionSummaryV1[]
): { transitions: Transition[]; next: StatusSnapshot } {
  const transitions: Transition[] = []
  const statuses: Record<string, BrowserSubmissionStatus> = {}
  for (const item of items) {
    statuses[item.submissionId] = item.status
    if (!snapshot.primed) continue
    const from = snapshot.statuses[item.submissionId] ?? null
    if (from === item.status || !ANNOUNCED.includes(item.status)) continue
    if (from === null && item.status !== "needs_input") continue
    transitions.push({ item, from, to: item.status })
  }
  return { transitions, next: { statuses, primed: true } }
}

/** The notification's message key for a transition. */
export function notificationMessageKey(to: BrowserSubmissionStatus): string {
  switch (to) {
    case "completed":
      return "notifyCompleted"
    case "failed":
      return "notifyFailed"
    default:
      return "notifyNeedsInput"
  }
}
