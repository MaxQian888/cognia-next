/**
 * Telegram outbound serialiser.
 *
 * Projects an `OutboundRequest` into one or more Telegram Bot-API calls.
 * Each call is `{ method, payload }` — the adapter posts them in order.
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { escapeMdV2 } from "./markdown-v2"
import { buildTelegramA2UICalls } from "./a2ui-mapper"

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

    case "a2ui":
      // A2UI segments require async projection (binding-row persistence
      // + SHA-1 hashing). The sync path falls back to `plainTextMirror`
      // so test stubs without an adapterId/conversationKey context still
      // get something legible. The adapter's send() method uses
      // `serializeOutboundAsync` to invoke the full native projection.
      return {
        method: "sendMessage",
        payload: { chat_id: chatId, text: seg.plainTextMirror, ...routing },
      }

    default:
      // Unsupported segment types silently dropped in Phase 1
      return null
  }
}

/**
 * Project an `OutboundRequest` into an ordered list of Telegram Bot API
 * calls (sync path). a2ui segments degrade to `plainTextMirror` because
 * the full native projection (InlineKeyboard + callback bindings)
 * requires Dexie writes — use `serializeOutboundAsync` from the adapter
 * `send()` method to get the rich projection.
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

/**
 * Async serializer used by the production adapter `send()`. a2ui segments
 * route through `buildTelegramA2UICalls` (InlineKeyboardMarkup + photo
 * uploads + binding-row persistence); other segments delegate to the
 * sync `serializeOutbound`.
 *
 * Walk order matches `req.segments` so the assistant's intended layout
 * is preserved (e.g., a2ui card followed by a markdown summary).
 */
export async function serializeOutboundAsync(
  req: OutboundRequest,
  adapterId: string
): Promise<SerializedTelegramCall[]> {
  const chatId = chatIdFromRef(req)
  const routing = routingFields(req)
  const calls: SerializedTelegramCall[] = []

  for (const seg of req.segments) {
    if (seg.type === "a2ui") {
      const a2uiCalls = await buildTelegramA2UICalls({
        adapterId,
        chatId,
        surfaceId: seg.surfaceId,
        surface: seg.content,
        conversationKey: extractConversationKey(req),
        routing,
      })
      if (a2uiCalls.length === 0) {
        // Mapper produced nothing native — fall back to the text mirror.
        calls.push({
          method: "sendMessage",
          payload: { chat_id: chatId, text: seg.plainTextMirror, ...routing },
        })
      } else {
        calls.push(...a2uiCalls)
      }
      continue
    }
    const call = serializeSegment(seg, chatId, routing)
    if (call) calls.push(call)
  }

  return calls
}

function extractConversationKey(req: OutboundRequest): string | undefined {
  const ref = req.conversationRef as Record<string, unknown>
  const adapterId = typeof ref["adapterId"] === "string" ? ref["adapterId"] : ""
  const chatId =
    typeof ref["chatId"] === "string" || typeof ref["chatId"] === "number"
      ? String(ref["chatId"])
      : ""
  if (!adapterId || !chatId) return undefined
  const thread = req.threadId
  return thread ? `telegram:${adapterId}:${chatId}:${thread}` : `telegram:${adapterId}:${chatId}`
}
