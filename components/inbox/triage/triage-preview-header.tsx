"use client"

/**
 * Header of the Inbox triage pane: who this is, where it came from, and the
 * one primary action — replying, which happens in the full chat.
 *
 * Same 48px seam as the list and sidebar headers so the three panes line up.
 * Identity on the left (platform glyph, title, adapter · platform), actions on
 * the right: contact profile, "Reply in chat" (primary; label collapses to the
 * icon when the pane is narrow), and close.
 */

import { useTranslations } from "next-intl"
import { MessageSquareReplyIcon, UserRoundIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { TriageConversation } from "@/hooks/inbox/use-triage-conversation"
import { PlatformBadge } from "../platform-badge"
import { ThreadMembershipChip } from "../thread-membership-chip"

export interface TriagePreviewHeaderProps {
  conversation: TriageConversation
  onOpenInChat: () => void
  onOpenContact: () => void
  /** Clears the preview. Omitted where the host owns dismissal (a drawer). */
  onClose?: () => void
}

export function TriagePreviewHeader({
  conversation,
  onOpenInChat,
  onOpenContact,
  onClose,
}: TriagePreviewHeaderProps) {
  const t = useTranslations("inbox.triage.header")
  const tPlatform = useTranslations("inbox.platformBadge")
  const { session, conversationKey, platform, adapter, adapterId } = conversation
  const title = session.title || conversationKey
  const platformName = tPlatform.has(`names.${platform}`)
    ? tPlatform(`names.${platform}`)
    : platform
  const source = [adapter?.displayName ?? adapterId, platformName].filter(Boolean).join(" · ")

  return (
    <header
      className="@container/triage-header flex h-[var(--chrome-h)] shrink-0 items-center gap-2 border-b px-3"
      data-testid="triage-preview-header"
    >
      <PlatformBadge platform={platform} iconOnly />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className="truncate text-sm font-medium" title={title}>
            {title}
          </h2>
          <ThreadMembershipChip conversationKey={conversationKey} className="shrink-0" />
        </div>
        <p className="truncate text-xs text-muted-foreground" title={conversationKey}>
          {source}
        </p>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={onOpenContact}
            aria-label={t("contact")}
            data-testid="triage-open-contact"
          >
            <UserRoundIcon className="size-4" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("contact")}</TooltipContent>
      </Tooltip>

      <Button
        type="button"
        size="sm"
        className="h-8 shrink-0 gap-1.5"
        onClick={onOpenInChat}
        aria-label={t("replyInChat")}
        aria-keyshortcuts="Enter"
        data-testid="triage-reply-in-chat"
      >
        <MessageSquareReplyIcon className="size-4" aria-hidden />
        <span className="hidden @[26rem]/triage-header:inline">{t("replyInChat")}</span>
      </Button>

      {onClose ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={onClose}
              aria-label={t("close")}
              data-testid="triage-close"
            >
              <XIcon className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("close")}</TooltipContent>
        </Tooltip>
      ) : null}
    </header>
  )
}
