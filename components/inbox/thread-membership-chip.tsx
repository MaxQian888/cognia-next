"use client"

/**
 * "This conversation is a thread" (ADR-0177, batch 2, the IM thread rendering).
 *
 * On Slack, Telegram topics, Matrix, and Lark a platform thread is its own
 * conversation here: its key carries the thread id, and it has its own
 * override row and session. Nothing said so on screen. This chip reads the
 * thread id back out of the key and, when the channel it hangs off is a
 * conversation we hold, links to it. No thread entity is invented (the ADR's
 * non-goal): the platform's own id is what is rendered.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { MessagesSquareIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useConversationOverride } from "@/hooks/connectors/use-conversation-overrides"
import { inboxConversationHref } from "@/lib/inbox/conversation-href"
import { buildConversationKey, parseConversationKey } from "@/types/connectors/event"

export interface ThreadMembershipChipProps {
  conversationKey: string
  className?: string
}

/** The parent channel's key for a thread conversation, or `null` when it is not one. */
export function parentConversationKeyOf(conversationKey: string): string | null {
  try {
    const parsed = parseConversationKey(conversationKey)
    if (!parsed.threadId) return null
    return buildConversationKey(parsed.platform, parsed.adapterId, parsed.remoteChatId)
  } catch {
    return null
  }
}

export function ThreadMembershipChip({ conversationKey, className }: ThreadMembershipChipProps) {
  const t = useTranslations("inbox.threadMembership")
  const parentKey = parentConversationKeyOf(conversationKey)
  const parent = useConversationOverride(parentKey ?? "")
  if (!parentKey) return null

  const badge = (
    <Badge
      variant="outline"
      className={className}
      data-testid="thread-membership-chip"
      data-parent={parent ? "known" : "unknown"}
    >
      <MessagesSquareIcon className="size-3" aria-hidden />
      {t("label")}
    </Badge>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {parent ? (
          <Link
            href={inboxConversationHref(parentKey)}
            aria-label={t("openParent")}
            data-testid="thread-membership-parent-link"
          >
            {badge}
          </Link>
        ) : (
          badge
        )}
      </TooltipTrigger>
      <TooltipContent>{parent ? t("openParent") : t("noParent")}</TooltipContent>
    </Tooltip>
  )
}
