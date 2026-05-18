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
    | "setMessageReaction"
  payload: Record<string, unknown>
  /**
   * Post-send binding intent (ADR-0009 v41 / B2). When set, the adapter's
   * send loop captures the returned platform `message_id` and records a
   * `kind: "force_reply"` binding on `connectorCallbackBindings` so the
   * parser can correlate the next inbound `reply_to_message.message_id`
   * back to the A2UI surface + component that asked for input.
   *
   * Only meaningful on `sendMessage` calls that carry a
   * `reply_markup.force_reply` payload — ignored otherwise.
   */
  forceReplyBinding?: {
    surfaceId: string
    componentId: string
    conversationKey?: string
  }
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

/**
 * Build a `setMessageReaction` Bot API call (added at ADR-0009 v41 / A1).
 *
 * Telegram's Bot API 7.0+ accepts a `ReactionType[]` where each entry is
 * either `{type: "emoji", emoji}` (unicode emoji) or `{type: "custom_emoji",
 * custom_emoji_id}` (a Telegram premium custom emoji id). Bots can only
 * push the `emoji` variant unless explicitly granted custom-emoji rights
 * by the chat admin, so this helper always emits the unicode form. Pass
 * an empty array to clear the bot's reactions on the message.
 *
 *   serializeReaction("123456", 42, "👍")         // add one reaction
 *   serializeReaction("123456", 42, ["👍", "❤"])  // add two reactions
 *   serializeReaction("123456", 42, [])           // clear bot reactions
 *
 * Reuses the same {method, payload} envelope as the other serializers so
 * the adapter's HTTP runner doesn't need a special path.
 */
export function serializeReaction(
  chatId: string | number,
  messageId: string | number,
  emoji: string | string[],
  opts?: { isBig?: boolean }
): SerializedTelegramCall {
  const list = Array.isArray(emoji) ? emoji : emoji.length > 0 ? [emoji] : []
  return {
    method: "setMessageReaction",
    payload: {
      chat_id: chatId,
      message_id: Number(messageId),
      reaction: list.map((e) => ({ type: "emoji", emoji: e })),
      ...(opts?.isBig ? { is_big: true } : {}),
    },
  }
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
