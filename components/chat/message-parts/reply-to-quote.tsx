"use client"

/**
 * The quoted message a row replies to (ADR-0177, batch 2).
 *
 * Renders `metadata.replyTo` above the body as one line of preview, the way
 * Slack and Telegram show a quoted message. The preview is stored on the
 * replying row, so the quote still reads when its target is gone. When the
 * target is in this pane's transcript the quote is a jump to it and the
 * speaker name comes from the target row. Otherwise it is plain text.
 */

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { CornerUpLeftIcon } from "lucide-react"
import { toast } from "sonner"
import type { MessageReplyTo } from "@cognia/agent-config-types"

import { resolveMessageSpeaker, type SpeakerSource } from "@/lib/chat/speaker"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"

export interface ReplyToQuoteProps {
  replyTo: MessageReplyTo
  /** The conversation the replying row lives in, for target lookup and jumps. */
  sessionId?: string | null
  className?: string
}

export function ReplyToQuote({ replyTo, sessionId, className }: ReplyToQuoteProps) {
  const t = useTranslations("chat.replyTo")
  const target = useChatStore((state) =>
    sessionId
      ? state.sessions[sessionId]?.messages.find((message) => message.id === replyTo.messageId)
      : undefined
  )
  const jump = useChatViewportStore((state) => state.jumpToMessage)
  const speakerLabel = useMemo(() => {
    if (!target) return null
    const speaker = resolveMessageSpeaker(target as unknown as SpeakerSource)
    return speaker?.label ?? (target.role === "assistant" ? t("assistant") : t("you"))
  }, [target, t])
  const canJump = Boolean(target && jump)

  const handleJump = useCallback(() => {
    if (!jump) return
    if (!jump(replyTo.messageId, undefined, { align: "center" })) toast.error(t("jumpFailed"))
  }, [jump, replyTo.messageId, t])

  const preview = replyTo.preview.trim()
  const body = (
    <>
      <CornerUpLeftIcon className="size-3 shrink-0" aria-hidden />
      {speakerLabel ? (
        <span className="shrink-0 font-medium" data-testid="reply-to-speaker">
          {speakerLabel}
        </span>
      ) : null}
      <span className="min-w-0 truncate" data-testid="reply-to-preview">
        {preview || t("emptyPreview")}
      </span>
    </>
  )
  const classes = cn(
    "mb-1.5 flex max-w-full items-center gap-1.5 border-s-2 border-primary/50 ps-2 text-xs text-muted-foreground",
    className
  )

  if (!canJump) {
    return (
      <div className={classes} data-testid="reply-to-quote" aria-label={t("label")}>
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      className={cn(classes, "cursor-pointer text-start hover:text-foreground")}
      onClick={handleJump}
      data-testid="reply-to-quote"
      aria-label={t("jumpLabel")}
    >
      {body}
    </button>
  )
}
