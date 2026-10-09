"use client"

/**
 * Binds `lib/inbox/bulk-triage.ts` to the real writers and reports the outcome.
 *
 * Every Inbox triage surface (row menu, keymap, bulk bar, the phone's
 * long-press sheet and swipe strips) calls `run(action, targets)`; this hook
 * is the one place that decides what the operator is told:
 *
 *  - one conversation, written in place (read, pin, label, …): silent — the
 *    row itself shows the change;
 *  - one conversation that leaves sight (resolve, archive): a toast with
 *    **Undo**, which restores the value captured before the write;
 *  - several conversations: a summary toast with the count (plural-aware),
 *    plus Undo for resolve / archive;
 *  - any failure: an error (or partial) toast naming how many failed.
 *
 * Writes never throw out of `run`; the settled result is returned so a caller
 * can, say, clear the checked set only when everything landed.
 */

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useSessions } from "@/hooks/chat/use-sessions"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import { notifyAssignmentChanged } from "@/lib/connectors/assignment/notify-assignment"
import { markSessionRead, markSessionUnread } from "@/lib/db/session-state"
import {
  applyTriageAction,
  bulkTriage,
  inverseTriageActions,
  isUndoableTriageAction,
  summarizeTriageResult,
  type BulkTriageResult,
  type TriageAction,
  type TriageTarget,
  type TriageWriters,
} from "@/lib/inbox/bulk-triage"

export interface UseTriageActionsResult {
  /** Run one action over `targets`. Never throws. */
  run: (action: TriageAction, targets: readonly TriageTarget[]) => Promise<BulkTriageResult>
  /** The bound writers, for a caller composing its own flow. */
  writers: TriageWriters
}

export function useTriageActions(): UseTriageActionsResult {
  const t = useTranslations("inbox.bulk")
  const { bulkSetPinned, archive, unarchive } = useSessions({ enabled: false })

  const writers = useMemo<TriageWriters>(
    () => ({
      markRead: markSessionRead,
      markUnread: markSessionUnread,
      setPinned: (sessionId, pinned) => bulkSetPinned([sessionId], pinned),
      setArchived: async (sessionId, archived) => {
        if (archived) await archive(sessionId)
        else await unarchive(sessionId)
      },
      setStatus: async ({ conversationKey, sessionId, status, snoozeUntil }) => {
        await mutateConversationOverride({
          kind: "setStatus",
          conversationKey,
          sessionId,
          status,
          snoozeUntil,
        })
      },
      setAssignee: async ({ conversationKey, sessionId, adapterId, assignee }) => {
        await mutateConversationOverride({
          kind: "setAssignee",
          conversationKey,
          sessionId,
          assignee,
          via: "manual",
          adapterId,
        })
      },
      addLabel: async ({ conversationKey, sessionId, labelId }) => {
        await mutateConversationOverride({ kind: "addLabel", conversationKey, sessionId, labelId })
      },
      removeLabel: async ({ conversationKey, sessionId, labelId }) => {
        await mutateConversationOverride({
          kind: "removeLabel",
          conversationKey,
          sessionId,
          labelId,
        })
      },
      notifyAssignment: ({ conversationKey, from, to }) =>
        notifyAssignmentChanged({ conversationKey, from, to, via: "manual" }),
    }),
    [bulkSetPinned, archive, unarchive]
  )

  const undo = useCallback(
    async (result: BulkTriageResult) => {
      const inverse = inverseTriageActions(result.action, result.succeeded, Date.now())
      const settled = await Promise.allSettled(
        inverse.map(({ action, target }) => applyTriageAction(action, target, writers))
      )
      const failed = settled.filter((outcome) => outcome.status === "rejected").length
      if (failed > 0) toast.error(t("undoFailed", { count: failed }))
      else toast.success(t("undone", { count: inverse.length }))
    },
    [t, writers]
  )

  const run = useCallback(
    async (action: TriageAction, targets: readonly TriageTarget[]) => {
      const result = await bulkTriage(action, targets, writers)
      const summary = summarizeTriageResult(result)
      const done = t(`done.${summary.messageKey}`, { count: summary.done })
      const undoAction =
        summary.done > 0 && isUndoableTriageAction(action)
          ? { label: t("undo"), onClick: () => void undo(result) }
          : undefined

      if (summary.tone === "success") {
        if (summary.attempted > 1 || undoAction) {
          toast.success(done, undoAction ? { action: undoAction } : undefined)
        }
      } else if (summary.tone === "partial") {
        toast.warning(done, {
          description: t("partialFailed", { count: summary.failed }),
          ...(undoAction ? { action: undoAction } : {}),
        })
      } else if (summary.tone === "error") {
        // The writer's own error text is English and internal; the toast says
        // what happened in the user's language instead.
        toast.error(t("failed", { count: summary.failed }), {
          description: t("failedDetail"),
        })
      }
      return result
    },
    [t, writers, undo]
  )

  return { run, writers }
}
