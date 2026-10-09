/**
 * Triage actions over one or many Inbox conversations.
 *
 * Every triage surface — the row's `⋯` menu, the keyboard keymap, the bulk
 * bar, the phone's long-press sheet and swipe strips — expresses an edit as a
 * {@link TriageAction} and runs it through {@link bulkTriage}. One code path
 * means the same write semantics everywhere: read state through
 * `markSessionRead` / `markSessionUnread`, pin and archive through the session
 * writers, and lifecycle / assignee / labels through
 * `mutateConversationOverride` (which routes to the local host or relays to a
 * paired one, ADR-0131).
 *
 * Pure apart from the injected {@link TriageWriters}: the hook that binds the
 * real writers (`hooks/inbox/use-triage-actions.ts`) owns the toasts, and the
 * helpers below (`toggleTriageAction`, `inverseTriageActions`,
 * `summarizeTriageResult`) are what it composes.
 *
 * Each conversation is written independently under `Promise.allSettled`: one
 * conversation whose override row cannot be created (or whose relay drops)
 * must not stop the other nineteen, and the caller learns exactly which ones
 * failed.
 */

import type { ConversationAssignee, ConversationStatus } from "@/lib/db/conversation-overrides"
import { effectiveStatus } from "@/lib/db/conversation-overrides"
import type { ConversationRowItem } from "./conversation-grouping"

export type TriageAction =
  | { kind: "markRead" }
  | { kind: "markUnread" }
  | { kind: "setPinned"; pinned: boolean }
  | { kind: "setArchived"; archived: boolean }
  | { kind: "setStatus"; status: ConversationStatus; snoozeUntil?: number }
  | { kind: "setAssignee"; assignee: ConversationAssignee | null }
  | { kind: "addLabel"; labelId: string }
  | { kind: "removeLabel"; labelId: string }

export type TriageActionKind = TriageAction["kind"]

/** What a write needs to know about one conversation, captured before it runs. */
export interface TriageTarget {
  sessionId: string
  conversationKey: string
  /** Bus-level adapter id, stamped on the assignment routing audit. */
  adapterId?: string
  status: ConversationStatus
  /** Only meaningful while `status === "snoozed"`. */
  snoozeUntil?: number
  assignee?: ConversationAssignee
  labelIds: readonly string[]
  pinned: boolean
  archived: boolean
  unread: boolean
}

export function triageTargetOf(row: ConversationRowItem): TriageTarget {
  const binding = row.session.platformBinding
  return {
    sessionId: row.session.id,
    conversationKey: binding?.conversationKey ?? "",
    adapterId: binding?.adapterId || undefined,
    status: effectiveStatus(row.override),
    snoozeUntil: row.override?.snoozeUntil,
    assignee: row.override?.assignee,
    labelIds: row.override?.labelIds ?? [],
    pinned: row.session.pinned === true,
    archived: row.session.archivedAt != null,
    unread: row.unreadCount > 0,
  }
}

/** The side effects a triage action can have, injected so this module stays pure. */
export interface TriageWriters {
  markRead: (sessionId: string) => Promise<void>
  markUnread: (sessionId: string) => Promise<void>
  setPinned: (sessionId: string, pinned: boolean) => Promise<void>
  setArchived: (sessionId: string, archived: boolean) => Promise<void>
  setStatus: (input: {
    conversationKey: string
    sessionId: string
    status: ConversationStatus
    snoozeUntil?: number
  }) => Promise<void>
  setAssignee: (input: {
    conversationKey: string
    sessionId: string
    adapterId?: string
    assignee: ConversationAssignee | null
  }) => Promise<void>
  addLabel: (input: {
    conversationKey: string
    sessionId: string
    labelId: string
  }) => Promise<void>
  removeLabel: (input: {
    conversationKey: string
    sessionId: string
    labelId: string
  }) => Promise<void>
  /**
   * Tell the Notification Center an assignment changed. Optional: a bulk
   * assignment skips it (see {@link BulkTriageOptions.notifyAssignment}).
   */
  notifyAssignment?: (input: {
    conversationKey: string
    from: ConversationAssignee | null
    to: ConversationAssignee | null
  }) => Promise<void>
}

/** True when running `action` on `target` would change nothing. */
export function isTriageNoop(action: TriageAction, target: TriageTarget): boolean {
  switch (action.kind) {
    case "markRead":
      return !target.unread
    case "markUnread":
      return target.unread
    case "setPinned":
      return target.pinned === action.pinned
    case "setArchived":
      return target.archived === action.archived
    case "setStatus":
      // Re-snoozing is never a no-op: it moves the wake-up time.
      return action.status !== "snoozed" && target.status === action.status
    case "setAssignee":
      return sameAssignee(target.assignee ?? null, action.assignee)
    case "addLabel":
      return target.labelIds.includes(action.labelId)
    case "removeLabel":
      return !target.labelIds.includes(action.labelId)
  }
}

function sameAssignee(a: ConversationAssignee | null, b: ConversationAssignee | null): boolean {
  if (!a || !b) return a === b
  return a.kind === b.kind && (a.id ?? null) === (b.id ?? null)
}

export interface ApplyTriageOptions {
  /** Notify the Notification Center of an assignment change (single-row edits). */
  notifyAssignment?: boolean
}

/** Run one action against one conversation. Throws what the writer throws. */
export async function applyTriageAction(
  action: TriageAction,
  target: TriageTarget,
  writers: TriageWriters,
  options: ApplyTriageOptions = {}
): Promise<void> {
  const { sessionId, conversationKey } = target
  switch (action.kind) {
    case "markRead":
      return writers.markRead(sessionId)
    case "markUnread":
      return writers.markUnread(sessionId)
    case "setPinned":
      return writers.setPinned(sessionId, action.pinned)
    case "setArchived":
      return writers.setArchived(sessionId, action.archived)
    case "setStatus":
      return writers.setStatus({
        conversationKey,
        sessionId,
        status: action.status,
        snoozeUntil: action.status === "snoozed" ? action.snoozeUntil : undefined,
      })
    case "setAssignee": {
      await writers.setAssignee({
        conversationKey,
        sessionId,
        adapterId: target.adapterId,
        assignee: action.assignee,
      })
      if (options.notifyAssignment && writers.notifyAssignment) {
        await writers.notifyAssignment({
          conversationKey,
          from: target.assignee ?? null,
          to: action.assignee,
        })
      }
      return
    }
    case "addLabel":
      return writers.addLabel({ conversationKey, sessionId, labelId: action.labelId })
    case "removeLabel":
      return writers.removeLabel({ conversationKey, sessionId, labelId: action.labelId })
  }
}

export interface BulkTriageFailure {
  sessionId: string
  error: unknown
}

export interface BulkTriageResult {
  action: TriageAction
  /** Targets the action was written to (no-ops excluded). */
  succeeded: TriageTarget[]
  failed: BulkTriageFailure[]
  /** Targets that already matched and were not written. */
  skipped: TriageTarget[]
}

export interface BulkTriageOptions {
  /**
   * Notify the Notification Center per assignment change. Defaults to true for
   * a single conversation only: a bulk assignment of thirty rows would raise
   * thirty toasts for a change the operator just made themselves; the bulk
   * summary toast reports it instead.
   */
  notifyAssignment?: boolean
}

/** Run `action` over every target independently; never throws. */
export async function bulkTriage(
  action: TriageAction,
  targets: readonly TriageTarget[],
  writers: TriageWriters,
  options: BulkTriageOptions = {}
): Promise<BulkTriageResult> {
  // Deduplicate by session: a target listed twice must not be written twice.
  const unique = Array.from(new Map(targets.map((target) => [target.sessionId, target])).values())
  const skipped = unique.filter((target) => isTriageNoop(action, target))
  const pending = unique.filter((target) => !isTriageNoop(action, target))
  const notifyAssignment = options.notifyAssignment ?? unique.length === 1
  const settled = await Promise.allSettled(
    pending.map((target) => applyTriageAction(action, target, writers, { notifyAssignment }))
  )
  const succeeded: TriageTarget[] = []
  const failed: BulkTriageFailure[] = []
  settled.forEach((outcome, index) => {
    const target = pending[index]!
    if (outcome.status === "fulfilled") succeeded.push(target)
    else failed.push({ sessionId: target.sessionId, error: outcome.reason })
  })
  return { action, succeeded, failed, skipped }
}

/** The toggles a single key (or one tap) flips. */
export type TriageToggle = "read" | "pin" | "archive"

/**
 * The action a toggle means for a set of conversations, mail-client style:
 * if ANY of them still needs the "forward" state, everything gets it;
 * only when all already have it does the toggle go back.
 *
 *  - read:    any unread → mark all read; else mark all unread
 *  - pin:     any unpinned → pin all; else unpin all
 *  - archive: any live → archive all; else unarchive all
 */
export function toggleTriageAction(
  toggle: TriageToggle,
  targets: readonly TriageTarget[]
): TriageAction {
  switch (toggle) {
    case "read":
      return targets.some((target) => target.unread) ? { kind: "markRead" } : { kind: "markUnread" }
    case "pin":
      return { kind: "setPinned", pinned: targets.some((target) => !target.pinned) }
    case "archive":
      return { kind: "setArchived", archived: targets.some((target) => !target.archived) }
  }
}

/** Tri-state of one label across a set of conversations. */
export type LabelCheckState = "checked" | "unchecked" | "mixed"

export function labelStateAcross(
  labelId: string,
  targets: readonly Pick<TriageTarget, "labelIds">[]
): LabelCheckState {
  if (targets.length === 0) return "unchecked"
  const carrying = targets.filter((target) => target.labelIds.includes(labelId)).length
  if (carrying === 0) return "unchecked"
  return carrying === targets.length ? "checked" : "mixed"
}

/** Toggling a tri-state label: mixed / unchecked add it everywhere, checked removes it. */
export function labelToggleAction(labelId: string, state: LabelCheckState): TriageAction {
  return state === "checked" ? { kind: "removeLabel", labelId } : { kind: "addLabel", labelId }
}

/**
 * What undoes `action` on each succeeded target, restoring the value captured
 * before the write. Only the actions that take a row out of sight offer an
 * undo (resolve and archive); the rest are visible in place and one more
 * keystroke away from reversal. A snooze whose wake-up has passed in the
 * meantime comes back as open rather than as a snooze that already ended.
 */
export function inverseTriageActions(
  action: TriageAction,
  succeeded: readonly TriageTarget[],
  now: number
): Array<{ action: TriageAction; target: TriageTarget }> {
  if (action.kind === "setArchived") {
    return succeeded.map((target) => ({
      action: { kind: "setArchived", archived: target.archived },
      target: { ...target, archived: action.archived },
    }))
  }
  if (action.kind === "setStatus" && action.status === "resolved") {
    return succeeded.map((target) => {
      const snoozeLive =
        target.status === "snoozed" && typeof target.snoozeUntil === "number"
          ? target.snoozeUntil > now
          : false
      const status: ConversationStatus =
        target.status === "snoozed" && !snoozeLive ? "open" : target.status
      return {
        action: {
          kind: "setStatus",
          status,
          snoozeUntil: status === "snoozed" ? target.snoozeUntil : undefined,
        },
        target: { ...target, status: "resolved", snoozeUntil: undefined },
      }
    })
  }
  return []
}

/** Whether {@link inverseTriageActions} would offer an undo for `action`. */
export function isUndoableTriageAction(action: TriageAction): boolean {
  return (
    action.kind === "setArchived" || (action.kind === "setStatus" && action.status === "resolved")
  )
}

/**
 * The i18n message (under `inbox.bulk.done`) that names what an action did.
 * Snooze and wake are statuses with their own wording.
 */
export type TriageMessageKey =
  | "markRead"
  | "markUnread"
  | "pin"
  | "unpin"
  | "archive"
  | "unarchive"
  | "open"
  | "pending"
  | "snooze"
  | "resolve"
  | "assign"
  | "unassign"
  | "labelAdd"
  | "labelRemove"

export function triageMessageKey(action: TriageAction): TriageMessageKey {
  switch (action.kind) {
    case "markRead":
      return "markRead"
    case "markUnread":
      return "markUnread"
    case "setPinned":
      return action.pinned ? "pin" : "unpin"
    case "setArchived":
      return action.archived ? "archive" : "unarchive"
    case "setStatus":
      return action.status === "resolved"
        ? "resolve"
        : action.status === "snoozed"
          ? "snooze"
          : action.status
    case "setAssignee":
      return action.assignee ? "assign" : "unassign"
    case "addLabel":
      return "labelAdd"
    case "removeLabel":
      return "labelRemove"
  }
}

export type TriageSummaryTone = "success" | "partial" | "error" | "none"

export interface TriageSummary {
  tone: TriageSummaryTone
  messageKey: TriageMessageKey
  /** Conversations written. */
  done: number
  failed: number
  /** Conversations the action touched (written + failed; no-ops excluded). */
  attempted: number
}

/** How a bulk result should be reported. */
export function summarizeTriageResult(result: BulkTriageResult): TriageSummary {
  const done = result.succeeded.length
  const failed = result.failed.length
  const attempted = done + failed
  const tone: TriageSummaryTone =
    attempted === 0 ? "none" : failed === 0 ? "success" : done === 0 ? "error" : "partial"
  return { tone, messageKey: triageMessageKey(result.action), done, failed, attempted }
}
