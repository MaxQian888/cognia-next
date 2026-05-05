/**
 * Telegram outbound serialiser.
 *
 * Projects an `OutboundRequest` into one or more Telegram Bot-API calls.
 * Each call is `{ method, payload }` — the adapter posts them in order.
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { escapeMdV2 } from "./markdown-v2"

export interface SerializedTelegramCall {
  /** Telegram Bot API method name. */
  method:
    | "sendMessage"
    | "sendPhoto"
    | "sendDocument"
    | "sendVoice"
    | "sendVideo"
    | "editMessageText"
    | "deleteMessage"
    | "sendChatAction"
  payload: Record<string, unknown>
}

/** Extract chat_id from the conversation reference. */
function chatIdFromRef(req: OutboundRequest): string | number {
  const ref = req.conversationRef as Record<string, unknown>
  return (ref["chatId"] as string | number | undefined) ?? ""
}

/** Build the reply + thread routing fields common to send* methods. */
function routingFields(req: OutboundRequest): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (req.replyTo?.messageId) {
    fields["reply_to_message_id"] = Number(req.replyTo.messageId)
  }
  if (req.threadId) {
    fields["message_thread_id"] = Number(req.threadId)
  }
  return fields
}

/** Turn a single segment into one or zero SerializedTelegramCall entries. */
function serializeSegment(
  seg: MessageSegment,
  chatId: string | number,
  routing: Record<string, unknown>
): SerializedTelegramCall | null {
  switch (seg.type) {
    case "text":
      return {
        method: "sendMessage",
        payload: { chat_id: chatId, text: seg.text, ...routing },
      }

    case "markdown":
      return {
        method: "sendMessage",
        payload: {
          chat_id: chatId,
          text: escapeMdV2(seg.md),
          parse_mode: "MarkdownV2",
          ...routing,
        },
      }

    case "code": {
      const lang = seg.language ?? ""
      const escaped = escapeMdV2(seg.code)
      const codeBlock = lang
        ? `\`\`\`${escapeMdV2(lang)}\n${escaped}\n\`\`\``
        : `\`\`\`\n${escaped}\n\`\`\``
      return {
        method: "sendMessage",
        payload: {
          chat_id: chatId,
          text: codeBlock,
          parse_mode: "MarkdownV2",
          ...routing,
        },
      }
    }

    case "image":
      return {
        method: "sendPhoto",
        payload: { chat_id: chatId, photo: seg.url, ...routing },
      }

    case "voice":
      return {
        method: "sendVoice",
        payload: { chat_id: chatId, voice: seg.url, ...routing },
      }

    case "video":
      return {
        method: "sendVideo",
        payload: { chat_id: chatId, video: seg.url, ...routing },
      }

    case "file":
      return {
        method: "sendDocument",
        payload: { chat_id: chatId, document: seg.url, ...routing },
      }

    case "mention": {
      // Inline mention rendered as MarkdownV2 text_mention link
      const name = escapeMdV2(seg.displayName ?? seg.userId)
      const mentionText = `[${name}](tg://user?id=${seg.userId})`
      return {
        method: "sendMessage",
        payload: {
          chat_id: chatId,
          text: mentionText,
          parse_mode: "MarkdownV2",
          ...routing,
        },
      }
    }

    case "reply":
      // Reply segments set replyTo — handled via routing fields; no separate call
      return null

    case "emoji":
      return {
        method: "sendMessage",
        payload: { chat_id: chatId, text: seg.code, ...routing },
      }

    default:
      // Unsupported segment types silently dropped in Phase 1
      return null
  }
}

/**
 * Project an `OutboundRequest` into an ordered list of Telegram Bot API calls.
 */
export function serializeOutbound(req: OutboundRequest): SerializedTelegramCall[] {
  const chatId = chatIdFromRef(req)
  const routing = routingFields(req)
  const calls: SerializedTelegramCall[] = []

  for (const seg of req.segments) {
    const call = serializeSegment(seg, chatId, routing)
    if (call) calls.push(call)
  }

  return calls
}
