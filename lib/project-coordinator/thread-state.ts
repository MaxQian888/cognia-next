import type { ChatSession } from "@cognia/agent-config-types"
import type { ChatStatus } from "@/stores/chat/chat-store"
import type { PrDerivedStatus } from "@/lib/github/pr-observe/types"

/**
 * One state per thread for the project board and the coordinator's digest
 * (ADR-0204), derived at read time from the row, the live slice and the
 * observed pull request — never stored, so it cannot drift from the facts.
 */

export type ThreadBoardState =
  | "waiting" // needs the user: an approval, a failed/interrupted turn, a blocker
  | "working" // a turn is in flight (or its brief is on the way)
  | "staged" // created, not started — the user presses Start
  | "ready-for-review" // a pull request is open
  | "landing" // the pull request is approved / mergeable
  | "idle" // finished its turn, nothing pending
  | "resolved" // done

/** Board order: what needs the user first. */
export const THREAD_BOARD_ORDER: readonly ThreadBoardState[] = [
  "waiting",
  "ready-for-review",
  "working",
  "staged",
  "landing",
  "idle",
  "resolved",
]

/** A week with no activity resolves a thread that is not doing anything. */
export const THREAD_AUTO_RESOLVE_MS = 7 * 24 * 60 * 60 * 1000

export interface ThreadStateInput {
  thread: ChatSession
  status: ChatStatus
  pendingApprovals: number
  pr?: PrDerivedStatus
  now: number
}

const REVIEW_PR: ReadonlySet<PrDerivedStatus> = new Set([
  "pr_open",
  "draft",
  "ci_pending",
  "ci_failed",
  "changes_requested",
  "merge_conflict",
  "review_pending",
])
const LANDING_PR: ReadonlySet<PrDerivedStatus> = new Set(["approved", "mergeable"])

export function deriveThreadState(input: ThreadStateInput): ThreadBoardState {
  const { thread, status, pendingApprovals, pr } = input
  if (thread.projectThread?.resolvedAt !== undefined) return "resolved"
  if (status === "awaiting_approval" || pendingApprovals > 0) return "waiting"
  if (status === "streaming") return "working"
  const lifecycle = thread.attachedChild?.status
  if (lifecycle === "staged") return "staged"
  // Started, brief not yet delivered or turn about to begin.
  if (lifecycle === "running" && thread.spawnedTask?.pendingPrompt) return "working"
  if (status === "error" || lifecycle === "interrupted") return "waiting"
  if (thread.projectThread?.declaredState === "blocked") return "waiting"
  if (pr && LANDING_PR.has(pr)) return "landing"
  if (pr && REVIEW_PR.has(pr)) return "ready-for-review"
  if (pr === "merged" || pr === "closed") return "idle"
  const declared = thread.projectThread?.declaredState
  if (declared === "landing") return "landing"
  if (declared === "ready-for-review") return "ready-for-review"
  return "idle"
}

/** Resolve a thread automatically: nothing in flight and a week without activity. */
export function shouldAutoResolve(input: ThreadStateInput): boolean {
  const state = deriveThreadState(input)
  if (state === "resolved" || state === "working") return false
  if (input.pendingApprovals > 0) return false
  return input.now - input.thread.updatedAt >= THREAD_AUTO_RESOLVE_MS
}
