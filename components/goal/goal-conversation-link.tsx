"use client"

/**
 * The conversation a goal runs in, as a link back to it (ADR-0019).
 *
 * The goal → chat path was missing everywhere: a goal row knew its
 * `sessionId` and offered no way to open the work. This renders the
 * conversation's title and opens it; a deleted conversation reads as such
 * instead of linking nowhere. The caller passes the resolved session (from
 * `useGoalSessions`, one read per list) — `undefined` while that read is in
 * flight, `null` once it is known to be gone.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { MessageSquareIcon } from "lucide-react"
import type { ChatSession } from "@cognia/agent-config-types"

import { buildSessionHref } from "@/lib/chat/message-permalink"
import { sessionDisplayTitle } from "@/lib/chat/placeholder-title"
import { cn } from "@/lib/utils"

export interface GoalConversationLinkProps {
  sessionId: string
  session: Pick<ChatSession, "id" | "title"> | null | undefined
  className?: string
}

/** Where a goal's conversation opens. */
export function goalConversationHref(sessionId: string): string {
  return `/${buildSessionHref(sessionId)}`
}

export function GoalConversationLink({ sessionId, session, className }: GoalConversationLinkProps) {
  const t = useTranslations("goal.conversation")
  const tRow = useTranslations("desktop.sessionRow")

  if (session === null) {
    return (
      <span
        className={cn("inline-flex min-w-0 items-center gap-1 text-muted-foreground/70", className)}
        data-testid="goal-conversation-missing"
      >
        <MessageSquareIcon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{t("missing")}</span>
      </span>
    )
  }

  const title =
    session === undefined
      ? t("loading")
      : sessionDisplayTitle(session.title, {
          untitled: tRow("untitled"),
          placeholder: tRow("placeholderTitle"),
        })

  return (
    <Link
      href={goalConversationHref(sessionId)}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60",
        className
      )}
      aria-label={t("open", { title })}
      data-testid="goal-conversation-link"
    >
      <MessageSquareIcon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{title}</span>
    </Link>
  )
}

GoalConversationLink.displayName = "GoalConversationLink"
