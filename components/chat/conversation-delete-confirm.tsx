"use client"

/**
 * "Delete this conversation?" — the one confirm both conversation lists ask
 * before a delete: the desktop row (its "⋯" / right-click Delete and the
 * Delete key) and the mobile drawer (its swipe and sheet Delete).
 *
 * Same copy, same branch note everywhere. The buttons are full-width 44px
 * rows stacked with Cancel at the bottom on a narrow screen (the platform
 * convention: where a hurried thumb lands first backs out instead of
 * deleting), and the usual right-aligned pair from `sm` up.
 *
 * Branches are standalone conversations — `direct` mode copies the messages
 * outright — so deleting the parent leaves them in the list and re-points them
 * at their grandparent. The note says so, or the count in the sidebar not
 * dropping reads as a bug. Its live count is its own component, mounted only
 * while the dialog is open: a desktop list hosts one confirm per row, and an
 * always-live count would be one index subscription per row re-run on every
 * session write.
 */

import { useTranslations } from "next-intl"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useClientLiveQuery } from "@/hooks/data"
import { sessionDisplayTitle } from "@/lib/chat/placeholder-title"
import { listSessionBranches } from "@/lib/db/sessions"
import type { ChatSession } from "@cognia/agent-config-types"

export interface ConversationDeleteConfirmProps {
  /** The conversation awaiting confirmation; `null` keeps the dialog closed. */
  session: ChatSession | null
  onCancel: () => void
  onConfirm: (session: ChatSession) => void
}

export function ConversationDeleteConfirm({
  session,
  onCancel,
  onConfirm,
}: ConversationDeleteConfirmProps) {
  const t = useTranslations("desktop.sessionRow")
  const title = session
    ? sessionDisplayTitle(session.title, {
        untitled: t("untitled"),
        placeholder: t("placeholderTitle"),
      })
    : ""

  return (
    <AlertDialog
      open={session !== null}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <AlertDialogContent
        className="max-w-[calc(100%-2rem)] sm:max-w-md"
        data-testid="conversation-delete-confirm"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            {t("deleteConfirmTitle", { title })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("deleteConfirmBody")}
            {session ? <BranchNote sessionId={session.id} /> : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AlertDialogCancel className="h-11 w-full sm:h-9 sm:w-auto">
            {t("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="h-11 w-full sm:h-9 sm:w-auto"
            data-testid="conversation-delete-confirm-action"
            onClick={() => {
              if (session) onConfirm(session)
            }}
          >
            {t("deleteConfirmAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function BranchNote({ sessionId }: { sessionId: string }) {
  const t = useTranslations("desktop.sessionRow")
  const branchCount =
    useClientLiveQuery<number>(
      async () => (await listSessionBranches(sessionId)).length,
      [sessionId],
      0
    ) ?? 0
  return branchCount > 0 ? <> {t("deleteConfirmBranches", { count: branchCount })}</> : null
}
