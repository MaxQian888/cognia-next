/**
 * Guarded issue-move semantics for the issue board.
 *
 * `canMoveIssue` is the SINGLE source of truth for which status transitions a
 * human (or an actor on the human's behalf) may perform. It is shared by:
 *   - the desktop board's drag-and-drop (illegal targets grey out at drag
 *     start via `allowedIssueMoveTargets`),
 *   - the mobile board's action sheet,
 *   - the IM card's move buttons (slice ③),
 *   - the run adapter's write-back.
 *
 * Ownership model — deliberately identical to
 * `lib/ai/agent/team/task-move-guard.ts`, so the two boards never disagree:
 *   - Federated rows (GitHub mirrors, agent-team tasks) are read-only here;
 *     their own surface owns them. The board must grey them out, not fail on
 *     write.
 *   - `in_progress` belongs to the runtime while a run is active. A run
 *     finishing pushes the issue to `in_review` and stops — promoting to
 *     `done` is the human's call, exactly as `review → completed` is on the
 *     team board.
 *   - Everything else is human-owned and permissive: an issue tracker should
 *     not argue with its user. Re-opening (`done → todo`) is legal.
 */

import type { IssueStatus } from "@/types/issues"
import { ISSUE_STATUSES } from "@/types/issues"
import type { UnifiedIssueCapabilities } from "@/types/issues/unified"

/** Why a move was denied — keyed for i18n at the UI layer. */
export type IssueMoveDenial =
  /** The row is not a local issue; its owning surface controls its status. */
  | "federated-read-only"
  /** `in_progress` is the runtime's while a run is in flight. */
  | "runtime-owned"
  | "illegal-transition"

export type IssueMoveVerdict = { allowed: true } | { allowed: false; reason: IssueMoveDenial }

/** Store/RPC-level move failure: a guard denial or a missing row. */
export type IssueMoveError = IssueMoveDenial | "issue-not-found"

export interface IssueMoveContext {
  /** True while an `IssueRunAdapter` run is in flight for this issue. */
  runActive: boolean
}

/**
 * Decide whether an issue may move `from` → `to`.
 *
 * `from` is passed explicitly rather than read off the row so callers
 * validating a stale snapshot (IM callbacks, RPC round-trips) surface the
 * mismatch at their own layer instead of silently applying to a moved card.
 */
export function canMoveIssue(
  capabilities: Pick<UnifiedIssueCapabilities, "canMove">,
  from: IssueStatus,
  to: IssueStatus,
  context: IssueMoveContext
): IssueMoveVerdict {
  if (!capabilities.canMove) {
    return { allowed: false, reason: "federated-read-only" }
  }

  // Same column: reordering — always fine.
  if (from === to) return { allowed: true }

  // The runtime owns `in_progress` while it is actually running something.
  // Both directions are locked: the user may neither yank a running issue out
  // nor shove another one in on top of it.
  if (context.runActive && (from === "in_progress" || to === "in_progress")) {
    return { allowed: false, reason: "runtime-owned" }
  }

  return { allowed: true }
}

/**
 * All statuses this issue may currently move to, excluding its own column
 * (which is always a legal reorder target). Drives dnd-kit droppable disabling
 * and the mobile action sheet.
 */
export function allowedIssueMoveTargets(
  capabilities: Pick<UnifiedIssueCapabilities, "canMove">,
  status: IssueStatus,
  context: IssueMoveContext
): IssueStatus[] {
  return ISSUE_STATUSES.filter(
    (to) => to !== status && canMoveIssue(capabilities, status, to, context).allowed
  )
}

/** Lifecycle timestamps implied by entering a status. */
export interface IssueStatusTimestamps {
  startedAt?: number
  completedAt?: number
  canceledAt?: number
}

/**
 * Timestamp patch for a status change. Returns only the fields that should be
 * written, so a re-open (`done → todo`) clears `completedAt` rather than
 * leaving a stale one behind.
 *
 * `undefined` values are meaningful here — the CRUD layer deletes those keys.
 */
export function statusTimestampPatch(
  to: IssueStatus,
  now: number,
  previous: IssueStatusTimestamps
): IssueStatusTimestamps {
  switch (to) {
    case "in_progress":
    case "in_review":
      return {
        startedAt: previous.startedAt ?? now,
        completedAt: undefined,
        canceledAt: undefined,
      }
    case "done":
      return {
        startedAt: previous.startedAt ?? now,
        completedAt: now,
        canceledAt: undefined,
      }
    case "canceled":
      return {
        startedAt: previous.startedAt,
        completedAt: undefined,
        canceledAt: now,
      }
    case "backlog":
    case "todo":
      // Re-opened: it has not started, finished, or been cancelled.
      return { startedAt: undefined, completedAt: undefined, canceledAt: undefined }
  }
}
