"use client"

// Permanently drop a message and everything after it.
//
// The counterpart to non-destructive editing: since `editAndResend` keeps the
// original question as a sibling branch rather than deleting its tail, this is
// the only remaining way to actually remove messages — and it is deliberately
// explicit, confirmed, and labelled as irreversible rather than being a silent
// side effect of rewording a question.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
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
import { truncateAfter } from "@/lib/db/messages"
import { mirrorTruncateToDesktop } from "@/lib/chat/mirror-truncate"
import { detectPlatform } from "@/hooks/use-platform"
import { useChatStore, selectVisibleMessages } from "@/stores/chat/chat-store"
import { createLogger } from "@cognia/logging"

const log = createLogger("chat-truncate")

interface Props {
  /** Session the message belongs to — NOT necessarily the focused one. */
  sessionId: string
  /** Cut-off message id; it and everything after it are removed. */
  messageId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Count what the user is about to lose, from the session's own visible thread.
 *
 * Counts VISIBLE messages rather than stored rows: hidden branch siblings go
 * too, but quoting the raw row count would read as wrong to someone looking at
 * a thread with half that many bubbles in it.
 */
export function countFromMessage(messages: readonly { id: string }[], messageId: string): number {
  const idx = messages.findIndex((m) => m.id === messageId)
  return idx < 0 ? 0 : messages.length - idx
}

export function TruncateFromDialog({ sessionId, messageId, open, onOpenChange }: Props) {
  const t = useTranslations("chat.truncateFrom")
  const [busy, setBusy] = useState(false)

  // Read the target session's OWN slice — this dialog is reachable from a split
  // pane or a sidechat, where the focused projection is a different thread.
  const visible = () => {
    const state = useChatStore.getState()
    const slice = state.sessions[sessionId]
    if (slice) return selectVisibleMessages(slice.messages, slice.activeBranchByGroup)
    if (sessionId === state.activeSessionId) {
      return selectVisibleMessages(state.messages, state.activeBranchByGroup)
    }
    return []
  }

  const count = open ? countFromMessage(visible(), messageId) : 0

  const onConfirm = async () => {
    setBusy(true)
    try {
      // On a paired phone the desktop holds the authoritative store, so a
      // local-only delete would be undone by the next sync — the host still has
      // every row. Fan the deletion out first, while the local rows this reads
      // to enumerate the range are still there. Same order as
      // `useTeamChat.editAndResend`, and best-effort for the same reason: sync
      // reconciles a failed remote delete, whereas blocking here would leave
      // the user unable to delete anything at all.
      if (detectPlatform() === "mobile") {
        await mirrorTruncateToDesktop(sessionId, messageId)
      }
      await truncateAfter(sessionId, messageId, { inclusive: true })
      // Re-read from Dexie rather than splicing the store: sibling branches and
      // their owned subtrees are dropped by the same key range, and rebuilding
      // that set in memory would be a second, divergent implementation.
      useChatStore.getState().requestSessionMessagesReload(sessionId)
      toast.success(t("done", { count }))
      onOpenChange(false)
    } catch (err) {
      log.error("truncate-failed", { sessionId, messageId, error: String(err) })
      toast.error(t("error"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("description", { count })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault()
              void onConfirm()
            }}
          >
            {t("confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
