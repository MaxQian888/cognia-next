"use client"

/**
 * Delete confirmation for the mobile conversation list.
 *
 * Swipe → Delete used to call `deleteSession` straight away: one sideways
 * flick past the reveal and the conversation, every message in it, was gone
 * with no way back. This is the desktop row's confirm (`session-row.tsx`) —
 * same copy, same branch note — sized for a phone: full-width 44px buttons,
 * stacked with Cancel at the bottom (the platform convention), so the place a
 * hurried thumb lands first backs out instead of deleting.
 *
 * The branch count is queried only while the dialog is open. The list renders
 * one of these for the whole list, not one per row, but an always-live count
 * would still re-run on every session write while the drawer is up.
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
import { listSessionBranches } from "@/lib/db/sessions"
import type { ChatSession } from "@cognia/agent-config-types"

export interface MobileChannelDeleteConfirmProps {
  /** The conversation awaiting confirmation; `null` keeps the dialog closed. */
  session: ChatSession | null
  onCancel: () => void
  onConfirm: (session: ChatSession) => void
}

export function MobileChannelDeleteConfirm({
  session,
  onCancel,
  onConfirm,
}: MobileChannelDeleteConfirmProps) {
  // Row vocabulary shared with the desktop sidebar, so both shells ask the
  // same question in the same words.
  const t = useTranslations("desktop.sessionRow")
  const open = session !== null
  const sessionId = session?.id ?? null
  const branchCount =
    useClientLiveQuery<number>(
      async () => (sessionId ? (await listSessionBranches(sessionId)).length : 0),
      [sessionId],
      0
    ) ?? 0
  const title = session ? session.title || t("untitled") : ""

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <AlertDialogContent
        className="max-w-[calc(100%-2rem)] sm:max-w-md"
        data-testid="mobile-channel-delete-confirm"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            {t("deleteConfirmTitle", { title })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("deleteConfirmBody")}
            {/* Branches are standalone conversations, so deleting the parent
                leaves them in the list. Say so, or the count not dropping
                reads as a bug. */}
            {branchCount > 0 ? ` ${t("deleteConfirmBranches", { count: branchCount })}` : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <AlertDialogCancel className="h-11 w-full sm:h-9 sm:w-auto">{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="h-11 w-full sm:h-9 sm:w-auto"
            data-testid="mobile-channel-delete-confirm-action"
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
