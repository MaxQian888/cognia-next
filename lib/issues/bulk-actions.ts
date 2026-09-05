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
  addIssueBlocker,
  addIssueComment,
  addIssueLabel,
  deleteIssue,
  linkIssueExternal,
  moveIssue,
  moveIssueToProject,
  removeIssueBlocker,
  removeIssueLabel,
  setIssueAssignee,
  setIssueCycle,
  setIssueDueDate,
  setIssueEstimate,
  setIssueParent,
  unlinkIssueExternal,
  updateIssue,
} from "@/lib/db/issues"
import { canMoveIssue, type IssueMoveDenial } from "./state-machine"
import type { IssueActor, IssueExternalRef, IssuePriority, IssueStatus } from "@/types/issues"
import type { IssueSourceMutation, UnifiedIssueItem } from "@/types/issues/unified"
import { parseUnifiedIssueId } from "@/types/issues/unified"
import { getIssueSourceRegistry } from "./sources/registry"

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
  /** Planning fields (v223). `null` clears. */
  | { kind: "cycle"; cycleId: string | null }
  | { kind: "dueDate"; to: number | null }
  | { kind: "estimate"; to: number | null }
  /** Relations (v223). Single-item by nature, so absent from `menu-model`. */
  | { kind: "parent"; parentId: string | null }
  | { kind: "addBlocker"; blockerId: string }
  | { kind: "removeBlocker"; blockerId: string }
  | { kind: "linkExternal"; ref: IssueExternalRef }
  | { kind: "unlinkExternal"; ref: Pick<IssueExternalRef, "provider" | "externalId"> }
  /** Append a comment. Single-item by nature, like `title`. */
  | { kind: "comment"; body: string }
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

/** Which capability bit an action needs. */
function requiredCapability(action: IssueBulkAction): keyof UnifiedIssueItem["capabilities"] {
  switch (action.kind) {
    case "status":
      return "canMove"
    case "assignee":
      return "canAssign"
    case "priority":
    case "title":
    case "description":
    case "cycle":
    case "dueDate":
    case "estimate":
    case "parent":
    case "addBlocker":
    case "removeBlocker":
    case "linkExternal":
    case "unlinkExternal":
      return "canEdit"
    case "addLabel":
    case "removeLabel":
      return "canManageLabels"
    case "project":
      return "canMoveProject"
    case "comment":
      return "canComment"
    case "delete":
      return "canDelete"
  }
}

/**
 * The subset a federated source's `mutate` understands. Anything else on a
 * federated row is a refusal, which `applyIssueBulkAction` counts as failed
 * rather than pretending the source took it.
 */
function toSourceMutation(action: IssueBulkAction): IssueSourceMutation | null {
  switch (action.kind) {
    case "status":
    case "title":
    case "description":
    case "priority":
    case "assignee":
    case "addLabel":
    case "removeLabel":
    case "project":
    case "comment":
    case "delete":
      return action
    default:
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
  const capability = requiredCapability(action)
  if (!item.capabilities[capability]) {
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
    case "cycle":
      await setIssueCycle(sourceId, action.cycleId, by)
      return
    case "dueDate":
      await setIssueDueDate(sourceId, action.to, by)
      return
    case "estimate":
      await setIssueEstimate(sourceId, action.to, by)
      return
    case "parent":
      await setIssueParent(sourceId, action.parentId, by)
      return
    case "addBlocker":
      await addIssueBlocker(sourceId, action.blockerId, by)
      return
    case "removeBlocker":
      await removeIssueBlocker(sourceId, action.blockerId, by)
      return
    case "linkExternal":
      await linkIssueExternal(sourceId, action.ref, by)
      return
    case "unlinkExternal":
      await unlinkIssueExternal(sourceId, action.ref, by)
      return
    case "comment":
      await addIssueComment(sourceId, action.body, by)
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
    if (!parsed) {
      skipped += 1
      reason ??= "federated-read-only"
      continue
    }
    try {
      if (parsed.kind === "local") {
        await applyOne(parsed.sourceId, action, by)
      } else {
        const source = getIssueSourceRegistry().getSource(parsed.kind)
        const mutation = toSourceMutation(action)
        if (!source?.mutate || !mutation) throw new Error("issue source is read-only")
        await source.mutate(parsed.sourceId, mutation, by)
      }
      applied += 1
    } catch {
      // One bad row must not abandon the rest of the selection.
      failed += 1
    }
  }

  return { applied, skipped, failed, ...(reason ? { reason } : {}) }
}
