"use client"

/**
 * IM cross-links on a message row.
 *
 *   - **Send to IM…** — pick a platform-bound conversation and deliver this
 *     message's text there as a manual reply (`lib/inbox/manual-send.ts`). Any
 *     message with text offers it: an answer worked out in the main chat can be
 *     forwarded to the customer without retyping.
 *   - **Continue in new chat** — for a message that arrived over a connector
 *     (`metadata.platformMessage`), start a fresh main-chat session with the
 *     message quoted into the composer, so the operator can think about it with
 *     the full toolset instead of inside the connector-bound pane.
 *
 * Rendered inside both `MessageActions` bars of `message-renderer.tsx`; each
 * action self-hides when it does not apply so the bar never carries a dead
 * button — and the whole thing stays out of the bar until at least one IM
 * connector is configured (`useImConfigured`), so a chat-only install never
 * sees IM chrome.
 */

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { MessageSquarePlusIcon, SendIcon } from "lucide-react"
import type { UIMessage } from "ai"
import { loggers } from "@cognia/logging"

import { MessageAction } from "@/components/ai-elements/message"
import {
  ConversationPickerDialog,
  type PlatformBoundSession,
} from "@/components/inbox/conversation-picker-dialog"
import { useImConfigured } from "@/hooks/inbox/use-im-configured"
import { startNewSession } from "@/lib/chat/start-session"
import { inboxConversationHref } from "@/lib/inbox/conversation-href"
import { sendManualTextToConversation } from "@/lib/inbox/manual-send"
import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { useUIStore } from "@/stores/ui"

/** Whether the message arrived over an IM connector (`runtime.ts:insertInboundMessage`). */
export function hasPlatformMessage(message: UIMessage): boolean {
  const meta = (message as { metadata?: { platformMessage?: unknown } }).metadata
  return meta?.platformMessage != null && typeof meta.platformMessage === "object"
}

/** Markdown blockquote of `text`, the same shape the row's own "quote" action produces. */
export function quoteForComposer(text: string): string {
  return `${text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n`
}

export interface MessageImActionsProps {
  message: UIMessage
  /** Plain text of the message's text parts (the renderer already has it). */
  text: string
  /**
   * The conversation this message belongs to. Offered as the picker's default
   * exclusion: forwarding a message to the conversation it came from is a
   * no-op the operator did not mean.
   */
  sessionId?: string | null
  className?: string
}

export function MessageImActions({ message, text, sessionId, className }: MessageImActionsProps) {
  const t = useTranslations("chat.message")
  const router = useRouter()
  const imConfigured = useImConfigured()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const trimmed = text.trim()
  const canSend = imConfigured && trimmed.length > 0
  const canContinue = hasPlatformMessage(message) && trimmed.length > 0

  const handleSendTo = useCallback(
    async (target: PlatformBoundSession) => {
      setSending(true)
      try {
        const result = await sendManualTextToConversation({ session: target, text: trimmed })
        const href = inboxConversationHref(result.conversationKey)
        toast.success(t("sendToImDone"), {
          description: target.title?.trim() || result.conversationKey,
          action: { label: t("sendToImOpen"), onClick: () => router.push(href) },
        })
      } catch (err) {
        loggers.chat.warn("send to IM failed", {
          sessionId: target.id,
          err: err instanceof Error ? err.message : String(err),
        })
        toast.error(t("sendToImFailed"), {
          description: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setSending(false)
      }
    },
    [trimmed, t, router]
  )

  const handleContinue = useCallback(async () => {
    try {
      // Mirrors the tray panel's delegate path: a fresh session, made active,
      // the DM guild in front, and the prompt staged (not sent) so the operator
      // can add their own question above the quote.
      const session = await startNewSession()
      useChatStore.getState().setActiveSession(session.id)
      useUIStore.getState().setSelectedGuild({ kind: "dm" })
      useComposerIntentStore.getState().stage(session.id, {
        candidateId: `im-continue:${message.id}`,
        prompt: quoteForComposer(trimmed),
      })
      router.push("/")
    } catch (err) {
      loggers.chat.warn("continue in new chat failed", {
        messageId: message.id,
        err: err instanceof Error ? err.message : String(err),
      })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }, [message.id, trimmed, router])

  if (!canSend && !canContinue) return null

  return (
    <>
      {canSend && (
        <MessageAction
          tooltip={t("sendToIm")}
          label={t("sendToIm")}
          className={className}
          disabled={sending}
          onClick={() => setPickerOpen(true)}
          data-testid="message-send-to-im"
        >
          <SendIcon className="size-3.5" />
        </MessageAction>
      )}
      {canContinue && (
        <MessageAction
          tooltip={t("continueInNewChat")}
          label={t("continueInNewChat")}
          className={className}
          onClick={() => void handleContinue()}
          data-testid="message-continue-in-new-chat"
        >
          <MessageSquarePlusIcon className="size-3.5" />
        </MessageAction>
      )}
      {/* Mounted only while open: every message row renders this component,
          and a Radix Dialog root per row is enough overhead to disturb the
          list's scroll bookkeeping (see QuoteCardDialog in the renderer). */}
      {pickerOpen && (
        <ConversationPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          excludeSessionId={sessionId ?? undefined}
          onSelect={(target) => void handleSendTo(target)}
        />
      )}
    </>
  )
}
