/**
 * Applying one edit to many issues.
 *
 * This is where eight exports that had no caller in the whole app finally get
 * one: `updateIssue`, `setIssueAssignee`, `addIssueLabel`, `removeIssueLabel`,
 * `moveIssueToProject` and `deleteIssue`, alongside `moveIssue`. Before this,
 * an issue could be created, dragged between columns, assigned and run — but
 * never renamed, re-prioritised, labelled, moved between containers or deleted.
 *
 * TWO RULES, both non-negotiable:
 *
 *  1. Every item is gated on its own `capabilities` before any write. A bulk
 *     action over a mixed selection must not fail halfway through on the first
 *     GitHub row — it skips it and reports the skip. ADR-0132 is explicit that
 *     the UI disables honestly rather than failing at write time; a bulk path
 *     that ignored capabilities would be that failure with extra steps.
 *  2. The outcome is COUNTED, not assumed. "12 issues updated" when four were
 *     silently skipped is a lie the user has no way to catch.
 */

import {
  addIssueLabel,
  deleteIssue,
  moveIssue,
  moveIssueToProject,
  removeIssueLabel,
  setIssueAssignee,
  updateIssue,
} from "@/lib/db/issues"
import { canMoveIssue, type IssueMoveDenial } from "./state-machine"
import type { IssueActor, IssuePriority, IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { parseUnifiedIssueId } from "@/types/issues/unified"

/**
 * One edit, expressed the same way whether it lands on one issue or twelve.
 *
 * `title` and `description` are in the vocabulary but deliberately absent from
 * `menu-model.ts`, so they never appear in a bulk menu: setting one title on a
 * dozen issues is not an edit anybody wants. They reach here from the
 * inspector's inline text editors, which pass a single item.
 */
export type IssueBulkAction =
  | { kind: "status"; to: IssueStatus }
  | { kind: "title"; to: string }
  | { kind: "description"; to: string }
  | { kind: "priority"; to: IssuePriority }
  | { kind: "assignee"; to: IssueActor | null }
  | { kind: "addLabel"; labelId: string }
  | { kind: "removeLabel"; labelId: string }
  | { kind: "project"; issueProjectId: string }
  | { kind: "delete" }

export interface IssueBulkOutcome {
  /** Rows the write actually landed on. */
  applied: number
  /** Rows refused before any write — read-only source, or a guard denial. */
  skipped: number
  /** Rows whose write threw. */
  failed: number
  /**
   * Why the first skip happened, so the toast can explain rather than just
   * counting. `undefined` when nothing was skipped.
   */
  reason?: IssueMoveDenial
}

/** Which capability bit an action needs. Delete is local-only, not a bit. */
function requiredCapability(
  action: IssueBulkAction
): keyof UnifiedIssueItem["capabilities"] | null {
  switch (action.kind) {
    case "status":
      return "canMove"
    case "assignee":
      return "canAssign"
    case "priority":
    case "title":
    case "description":
    case "addLabel":
    case "removeLabel":
    case "project":
      return "canEdit"
    case "delete":
      return null
  }
}

/**
 * May this action run on this item? Pure, and exported so the toolbar can grey
 * out an action the whole selection would refuse instead of offering it and
 * then reporting zero changes.
 */
export function canApplyBulkAction(
  item: UnifiedIssueItem,
  action: IssueBulkAction,
  runActive: boolean
): { ok: true } | { ok: false; reason: IssueMoveDenial } {
  // Only local rows have a writable row behind them at all.
  if (item.kind !== "local") return { ok: false, reason: "federated-read-only" }

  const capability = requiredCapability(action)
  if (capability && !item.capabilities[capability]) {
    return { ok: false, reason: "federated-read-only" }
  }

  if (action.kind === "status") {
    const verdict = canMoveIssue(item.capabilities, item.status, action.to, { runActive })
    if (!verdict.allowed) return { ok: false, reason: verdict.reason }
  }

  return { ok: true }
}

/** How many of a selection an action would actually touch. */
export function countApplicableItems(
  items: readonly UnifiedIssueItem[],
  action: IssueBulkAction,
  runningIds: ReadonlySet<string>
): number {
  return items.reduce(
    (total, item) =>
      total + (canApplyBulkAction(item, action, runningIds.has(item.unifiedId)).ok ? 1 : 0),
    0
  )
}

async function applyOne(sourceId: string, action: IssueBulkAction, by: IssueActor): Promise<void> {
  switch (action.kind) {
    case "status": {
      const denial = await moveIssue({ id: sourceId, to: action.to, by })
      // The guard already passed; anything left is a genuine write failure.
      if (denial && denial !== "issue-not-found") throw new Error(denial)
      return
    }
    case "priority":
      await updateIssue(sourceId, { priority: action.to }, by)
      return
    case "title":
      await updateIssue(sourceId, { title: action.to }, by)
      return
    case "description":
      await updateIssue(sourceId, { description: action.to }, by)
      return
    case "assignee":
      await setIssueAssignee(sourceId, action.to, by)
      return
    case "addLabel":
      await addIssueLabel(sourceId, action.labelId, by)
      return
    case "removeLabel":
      await removeIssueLabel(sourceId, action.labelId, by)
      return
    case "project":
      await moveIssueToProject(sourceId, action.issueProjectId, by)
      return
    case "delete":
      await deleteIssue(sourceId)
      return
  }
}

/**
 * Apply one action across a selection.
 *
 * Writes are sequential on purpose: these all land in the same Dexie tables and
 * each appends an event, and a parallel fan-out over the same rows buys
 * nothing but contention and a non-deterministic event order in the activity
 * trail.
 */
export async function applyIssueBulkAction(
  items: readonly UnifiedIssueItem[],
  action: IssueBulkAction,
  by: IssueActor,
  runningIds: ReadonlySet<string> = new Set()
): Promise<IssueBulkOutcome> {
  let applied = 0
  let skipped = 0
  let failed = 0
  let reason: IssueMoveDenial | undefined

  for (const item of items) {
    const verdict = canApplyBulkAction(item, action, runningIds.has(item.unifiedId))
    if (!verdict.ok) {
      skipped += 1
      reason ??= verdict.reason
      continue
    }
    const parsed = parseUnifiedIssueId(item.unifiedId)
    if (parsed?.kind !== "local") {
      skipped += 1
      reason ??= "federated-read-only"
      continue
    }
    try {
      await applyOne(parsed.sourceId, action, by)
      applied += 1
    } catch {
      // One bad row must not abandon the rest of the selection.
      failed += 1
    }
  }

  return { applied, skipped, failed, ...(reason ? { reason } : {}) }
}
