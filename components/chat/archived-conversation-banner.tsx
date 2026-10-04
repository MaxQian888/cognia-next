"use client"

/**
 * Says an open conversation is archived and offers Unarchive (ADR-0213,
 * decision D2). Mounted above the transcript of the chat pane, so a
 * conversation opened from the archive (the sidebar's archived view, the
 * conversation manager, search) never reads as an ordinary one. Renders
 * nothing for an active conversation.
 *
 * Sending a message restores the conversation on its own
 * (`useUnarchiveOnUserTurn`); the body says so, so the user knows they need
 * not press the button first.
 */

import { useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { ArchiveIcon, ArchiveRestoreIcon, LockKeyholeIcon } from "lucide-react"
import type { ChatSession } from "@cognia/agent-config-types"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useSessionArchiveActions } from "@/hooks/chat/use-session-archive-actions"

export interface ArchivedConversationBannerProps {
  session: ChatSession
  className?: string
}

export function ArchivedConversationBanner({
  session,
  className,
}: ArchivedConversationBannerProps) {
  if (session.archivedAt == null) return null
  return <ArchivedBanner session={session} archivedAt={session.archivedAt} className={className} />
}

/** Split out so the clock and the write hook only run for an archived row. */
function ArchivedBanner({
  session,
  archivedAt,
  className,
}: {
  session: ChatSession
  archivedAt: number
  className?: string
}) {
  const t = useTranslations("conversations.banner")
  const tWrite = useTranslations("chat.sessionWrite")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const { unarchive } = useSessionArchiveActions()
  const [busy, setBusy] = useState(false)
  const locked = Boolean(session.handoffLock)

  const restore = () => {
    setBusy(true)
    // Never rejects; a refusal or failure is toasted by the hook. On success
    // the row leaves the archive and this banner unmounts.
    void unarchive([session]).finally(() => setBusy(false))
  }

  return (
    <Alert className={className} role="status" data-testid="archived-conversation-banner">
      <ArchiveIcon />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{t("body", { since: format.relativeTime(archivedAt, now) })}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || locked}
          onClick={restore}
          data-testid="archived-conversation-unarchive"
        >
          <ArchiveRestoreIcon aria-hidden className="size-3.5" />
          {t("unarchive")}
        </Button>
        {locked ? (
          <span
            className="flex w-full items-center gap-1.5 text-xs"
            data-testid="archived-conversation-locked"
          >
            <LockKeyholeIcon aria-hidden className="size-3.5 shrink-0 text-amber-600" />
            {tWrite("actionLocked")}
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
