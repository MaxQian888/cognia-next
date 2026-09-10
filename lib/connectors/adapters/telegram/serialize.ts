/**
 * Telegram outbound serialiser.
 *
 * Projects an `OutboundRequest` into one or more Telegram Bot-API calls.
 * Each call is `{ method, payload }` — the adapter posts them in order.
 */

import type { OutboundRequest, SegmentDowngrade } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import {
  escapeMdV2,
  escapeMdV2Code,
  chunkTelegramText,
  chunkTelegramMarkdownV2,
  TELEGRAM_TEXT_LIMIT,
} from "./markdown-v2"
import { mdToMarkdownV2 } from "./md-to-mdv2"
import { buildTelegramA2UICalls } from "./a2ui-mapper"

import { walkA2UISurface } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { TELEGRAM_A2UI_CAPABILITY } from "./capability"

export class TelegramSerializationError extends Error {}

export interface SerializedTelegramCall {
  /** Local rendering diagnostics; never sent to the platform. */
  downgrades?: SegmentDowngrade[]
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
  /** Local upload hints; consumed by the adapter, never sent in the JSON payload. */
  upload?: { filename?: string; contentType?: string }
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
    // Bot API 7.0 replaced the top-level `reply_to_message_id` parameter
    // with the `reply_parameters` object (audited fix #6). The reply target
    // may arrive as the composite "chatId:messageId" send() returns — use
    // the message part.
    const raw = String(req.replyTo.messageId)
    const idx = raw.indexOf(":")
    fields["reply_parameters"] = {
      message_id: Number(idx === -1 ? raw : raw.slice(idx + 1)),
    }
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
      // Real CommonMark → MarkdownV2 conversion (audited fix #5) — the old
      // path escaped the whole source, so **bold** rendered literally.
      return {
        method: "sendMessage",
        payload: {
          chat_id: chatId,
          text: mdToMarkdownV2(seg.md),
          parse_mode: "MarkdownV2",
          ...routing,
        },
      }

    case "code": {
      // Inside a pre entity only ` and \ must be escaped (audited fix #4a);
      // the language tag is sanitised rather than escaped because escape
      // sequences are not valid on the fence line.
      const lang = (seg.language ?? "").replace(/[^\w+-]/g, "")
      const escaped = escapeMdV2Code(seg.code)
      const codeBlock = `\`\`\`${lang}\n${escaped}\n\`\`\``
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
        upload: { contentType: seg.mimeType },
      }

    case "voice":
      return {
        method: "sendVoice",
        payload: { chat_id: chatId, voice: seg.url, ...routing },
        upload: { contentType: seg.mimeType },
      }

    case "video":
      return {
        method: "sendVideo",
        payload: { chat_id: chatId, video: seg.url, ...routing },
        upload: { contentType: seg.mimeType },
      }

    case "file":
      return {
        method: "sendDocument",
        payload: { chat_id: chatId, document: seg.url, ...routing },
        upload: { filename: seg.name, contentType: seg.mimeType },
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

    case "location":
    case "poll": {
      const text =
        seg.type === "location"
          ? [seg.name, String(seg.lat) + ", " + String(seg.lon)].filter(Boolean).join("\n")
          : [
              seg.question,
              ...(seg.multi ? ["Multiple selections allowed"] : []),
              ...seg.options.map((option, index) => String(index + 1) + ". " + option),
            ].join("\n")
      const downgrades: SegmentDowngrade[] = [
        {
          from: seg.type,
          to: "text",
          reason:
            "Native " + seg.type + " sending is unavailable; complete content retained as text",
        },
      ]
      return { method: "sendMessage", payload: { chat_id: chatId, text, ...routing }, downgrades }
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

const TELEGRAM_INLINE_TYPES = new Set(["text", "markdown", "code", "mention", "emoji"])
const TELEGRAM_BLOCK_TYPES = new Set(["text", "markdown", "code"])

/** Group adjacent content so mentions remain inside the sentence containing them. */
function segmentRuns(segments: MessageSegment[]): MessageSegment[][] {
  const runs: MessageSegment[][] = []
  let content: MessageSegment[] = []
  for (const segment of segments) {
    if (segment.type === "reply") continue
    if (TELEGRAM_INLINE_TYPES.has(segment.type)) content.push(segment)
    else {
      if (content.length) runs.push(content)
      content = []
      runs.push([segment])
    }
  }
  if (content.length) runs.push(content)
  return runs
}

function serializeRun(
  run: MessageSegment[],
  chatId: string | number,
  routing: Record<string, unknown>
): SerializedTelegramCall | null {
  if (run.length === 1) return serializeSegment(run[0], chatId, routing)
  const calls = run.map((segment) => serializeSegment(segment, chatId, routing)!)
  const formatted = calls.some((call) => call.payload.parse_mode === "MarkdownV2")
  let text = ""
  for (const [index, call] of calls.entries()) {
    if (
      index > 0 &&
      TELEGRAM_BLOCK_TYPES.has(run[index].type) &&
      TELEGRAM_BLOCK_TYPES.has(run[index - 1].type) &&
      !text.endsWith("\n")
    )
      text += "\n"
    const body = String(call.payload.text ?? "")
    text += formatted && !call.payload.parse_mode ? escapeMdV2(body) : body
  }
  return {
    method: "sendMessage",
    payload: {
      chat_id: chatId,
      text,
      ...(formatted ? { parse_mode: "MarkdownV2" } : {}),
      ...routing,
    },
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
  if (req.segments.some((segment) => segment.type === "card")) {
    throw new TelegramSerializationError(
      "Opaque native cards are not supported by telegram; use an A2UI surface or text"
    )
  }
  const chatId = chatIdFromRef(req)
  const routing = routingFields(req)
  const calls: SerializedTelegramCall[] = []

  for (const run of segmentRuns(req.segments)) {
    const call = serializeRun(run, chatId, routing)
    if (call) calls.push(call)
  }

  return expandOversizedTextCalls(calls)
}

/**
 * Split sendMessage calls whose text exceeds Telegram's 4096-char hard limit
 * into multiple sequential sends (audited fix #7). Reply context stays on
 * the first chunk; reply_markup (inline keyboard / force_reply) moves to the
 * last chunk so it sits under the final visible part.
 */
function expandOversizedTextCalls(calls: SerializedTelegramCall[]): SerializedTelegramCall[] {
  const out: SerializedTelegramCall[] = []
  for (const call of calls) {
    const text = call.payload["text"]
    if (
      call.method !== "sendMessage" ||
      typeof text !== "string" ||
      text.length <= TELEGRAM_TEXT_LIMIT
    ) {
      out.push(call)
      continue
    }
    const formatted = call.payload["parse_mode"] === "MarkdownV2"
    const chunks = formatted
      ? chunkTelegramMarkdownV2(text)
      : chunkTelegramText(text).map((text) => ({ text }))
    chunks.forEach((chunk, idx) => {
      const payload: Record<string, unknown> = { ...call.payload, ...chunk }
      if (formatted) delete payload["parse_mode"]
      if (idx > 0) delete payload["reply_parameters"]
      if (idx < chunks.length - 1) delete payload["reply_markup"]
      out.push({
        method: call.method,
        payload,
        ...(idx === 0 && call.downgrades ? { downgrades: call.downgrades } : {}),
        ...(idx === chunks.length - 1 && call.forceReplyBinding
          ? { forceReplyBinding: call.forceReplyBinding }
          : {}),
      })
    })
  }
  return out
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
  if (req.segments.some((segment) => segment.type === "card")) {
    throw new TelegramSerializationError(
      "Opaque native cards are not supported by telegram; use an A2UI surface or text"
    )
  }
  const chatId = chatIdFromRef(req)
  const routing = routingFields(req)
  const calls: SerializedTelegramCall[] = []

  for (const run of segmentRuns(req.segments)) {
    const seg = run[0]
    if (seg.type === "a2ui") {
      const fallbackKinds = new Set<string>()
      walkA2UISurface(seg.content, (node) => {
        const support = (TELEGRAM_A2UI_CAPABILITY as Readonly<Record<string, string>>)[
          node.component
        ]
        if (support !== "native" && support !== "simulated") fallbackKinds.add(node.component)
      })
      const downgrades: SegmentDowngrade[] = fallbackKinds.size
        ? [
            {
              from: "a2ui",
              to: "text",
              reason:
                "A2UI surface " +
                seg.surfaceId +
                " uses its text mirror for: " +
                [...fallbackKinds].join(", "),
            },
          ]
        : []

      const a2uiCalls = await buildTelegramA2UICalls({
        adapterId,
        chatId,
        surfaceId: seg.surfaceId,
        surface: seg.content,
        conversationKey: extractConversationKey(req),
        routing,
      })
      if (a2uiCalls.length === 0 || fallbackKinds.size > 0) {
        // Mapper produced nothing native — fall back to the text mirror.
        calls.push({
          method: "sendMessage",
          payload: { chat_id: chatId, text: seg.plainTextMirror, ...routing },
          ...(downgrades.length ? { downgrades } : {}),
        })
      }
      calls.push(...a2uiCalls)
      continue
    }
    const call = serializeRun(run, chatId, routing)
    if (call) calls.push(call)
  }

  return expandOversizedTextCalls(calls)
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
