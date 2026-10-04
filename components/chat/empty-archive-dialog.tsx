"use client"

/**
 * "Empty archive" — permanently delete every archived conversation in a scope.
 *
 * One confirm for every surface that offers it: the desktop sidebar's archive
 * view, the phone drawer's Archived tab and the conversation manager. The
 * caller hands it the archived rows of the scope it is showing (all of them,
 * not the rendered ones: a group preview cap or a collapsed section must not
 * make "everything" quietly mean "what is on screen").
 *
 * - The dialog names the count and the first few titles, like the bulk delete
 *   confirm, and the scope when the caller has one to name.
 * - A conversation handed off to another device cannot be deleted; it is left
 *   out of the delete and the dialog says how many stay, rather than refusing
 *   the whole batch over one row.
 * - The delete is routed (`deleteSessionsRouted`): a paired client asks its
 *   Host, standalone runs the full teardown. Feedback goes through
 *   `useSessionWrite`, so a failure is toasted, never swallowed.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { useSessionWrite } from "@/hooks/chat/use-session-write"
import { sessionDisplayTitle } from "@/lib/chat/placeholder-title"
import { deleteSessionsRouted } from "@/lib/chat/session-archive-writes"
import { trackConversationRowAction } from "@/lib/telemetry/conversation-list-events"

/** Titles the confirm lists before it summarizes the rest. */
const TITLE_LIMIT = 5

export interface EmptyArchiveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The archived conversations of the scope being emptied. Active rows are ignored. */
  sessions: readonly ChatSession[]
  /** The scope, when the surface has one worth naming ("Workspace A"). */
  scopeLabel?: string
  /** Runs after the delete landed. */
  onEmptied?: () => void
}

export function EmptyArchiveDialog({
  open,
  onOpenChange,
  sessions,
  scopeLabel,
  onEmptied,
}: EmptyArchiveDialogProps) {
  const t = useTranslations("conversations.archive.empty")
  const tRow = useTranslations("desktop.sessionRow")
  const runWrite = useSessionWrite()
  const [busy, setBusy] = useState(false)

  const { deletable, lockedCount } = useMemo(() => {
    const archived = sessions.filter((session) => session.archivedAt != null)
    const unlocked = archived.filter((session) => !session.handoffLock)
    return { deletable: unlocked, lockedCount: archived.length - unlocked.length }
  }, [sessions])
  const titles = useMemo(
    () =>
      deletable.map((session) =>
        sessionDisplayTitle(session.title, {
          untitled: tRow("untitled"),
          placeholder: tRow("placeholderTitle"),
        })
      ),
    [deletable, tRow]
  )
  const count = deletable.length

  const confirm = async () => {
    if (count === 0) return
    setBusy(true)
    void trackConversationRowAction("delete", count)
    const ids = deletable.map((session) => session.id)
    const ok = await runWrite("delete", deletable, () => deleteSessionsRouted(ids), {
      success: t("success", { count }),
    })
    setBusy(false)
    if (ok) {
      onOpenChange(false)
      onEmptied?.()
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent className="max-w-[90vw] sm:max-w-md" data-testid="empty-archive-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {count > 0 ? t("title", { count }) : t("nothingTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {count > 0 ? t("body") : t("nothingBody")}
            {scopeLabel ? ` ${t("scope", { scope: scopeLabel })}` : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {count > 0 ? (
          <ul
            className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/40 px-3 py-2 text-sm"
            data-testid="empty-archive-titles"
          >
            {titles.slice(0, TITLE_LIMIT).map((title, index) => (
              <li key={deletable[index]!.id} className="truncate">
                {title}
              </li>
            ))}
            {titles.length > TITLE_LIMIT ? (
              <li className="text-xs text-muted-foreground">
                {t("more", { count: titles.length - TITLE_LIMIT })}
              </li>
            ) : null}
          </ul>
        ) : null}
        {lockedCount > 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="empty-archive-locked-note">
            {t("lockedKept", { count: lockedCount })}
          </p>
        ) : null}
        <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
          <AlertDialogCancel className="w-full sm:w-auto" disabled={busy}>
            {t("cancel")}
          </AlertDialogCancel>
          {count > 0 ? (
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={() => void confirm()}
              data-testid="empty-archive-confirm"
            >
              {t("confirm", { count })}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
