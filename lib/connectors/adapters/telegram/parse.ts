/**
 * Telegram update → NormalizedInboundEvent parser.
 *
 * Handles the four update types Phase 1 + Phase 2 surface:
 * - `message`         → kind="create" with text + photo segments.
 * - `channel_post`    → kind="create" (anonymous channel post).
 * - `edited_message`  → kind="edit" with `replacesMessageId` set so the bus
 *                       can update the existing StoredMessage in place.
 * - `callback_query`  → kind="create" with a single text segment carrying
 *                       the button payload. Treated as a fresh message so
 *                       downstream gates (rate-limit, dedup) apply normally.
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"

// ---------------------------------------------------------------------------
// Minimal Telegram Bot API types (only the fields we consume)
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: "private" | "group" | "supergroup" | "channel"
  title?: string
  username?: string
  first_name?: string
  last_name?: string
  is_forum?: boolean
}

export interface TelegramMessageEntity {
  type: string
  offset: number
  length: number
  user?: TelegramUser
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  file_size?: number
  width: number
  height: number
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  message_thread_id?: number
  text?: string
  caption?: string
  entities?: TelegramMessageEntity[]
  photo?: TelegramPhotoSize[]
  reply_to_message?: TelegramMessage
  /** Set on edited_message updates — Telegram's wall-clock for the edit. */
  edit_date?: number
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
  /** Inline-keyboard data passthrough; rare. Not used by parse logic. */
  game_short_name?: string
  inline_message_id?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  edited_channel_post?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSenderId(chatId: number, userId: number): string {
  return `tg:${chatId}:${userId}`
}

function buildPlatformIdentity(
  adapterId: string,
  chatId: number,
  user: TelegramUser
): PlatformIdentity {
  return {
    id: buildSenderId(chatId, user.id),
    platform: "telegram",
    adapterId,
    remoteUserId: String(user.id),
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username,
    avatarUrl: undefined,
  }
}

/**
 * Detect if the bot (@selfUsername derived from selfId) is mentioned via
 * entities, or if the message is a direct reply to the bot's own message.
 */
function detectMentions(
  selfId: string,
  msg: TelegramMessage
): { selfMentioned: boolean; users: string[] } {
  const users: string[] = []
  let selfMentioned = false

  // Check reply_to_message — reply to bot's message counts as self-mention
  if (msg.reply_to_message?.from?.id !== undefined) {
    const replieeId = String(msg.reply_to_message.from.id)
    if (replieeId === selfId) {
      selfMentioned = true
    }
  }

  // Check entities for @mention type
  if (msg.entities) {
    for (const entity of msg.entities) {
      if (entity.type === "mention") {
        // Extract the mentioned username from text
        const start = entity.offset
        const end = entity.offset + entity.length
        const mentioned = (msg.text ?? "").slice(start, end).trim()
        users.push(mentioned)
      } else if (entity.type === "text_mention" && entity.user) {
        users.push(String(entity.user.id))
        if (String(entity.user.id) === selfId) {
          selfMentioned = true
        }
      }
    }
  }

  return { selfMentioned, users }
}

function buildSegments(msg: TelegramMessage): MessageSegment[] {
  const segments: MessageSegment[] = []

  // Photo message: image segment first, then caption as text if present
  if (msg.photo && msg.photo.length > 0) {
    // Pick the largest photo variant
    const largest = msg.photo.reduce((best, p) =>
      p.file_size !== undefined && (best.file_size ?? 0) < p.file_size ? p : best
    )
    segments.push({
      type: "image",
      url: `tg://file/${largest.file_id}`,
      width: largest.width,
      height: largest.height,
    })
    if (msg.caption) {
      segments.push({ type: "text", text: msg.caption })
    }
    return segments
  }

  // Plain text message
  if (msg.text) {
    segments.push({ type: "text", text: msg.text })
  } else if (msg.caption) {
    segments.push({ type: "text", text: msg.caption })
  }

  return segments
}

/**
 * Project a Telegram message into a NormalizedInboundEvent. Shared by the
 * regular-message, channel-post, and edited-message paths so all three carry
 * identical sender / channel / mention metadata. The caller decides the
 * `kind` and (for edits) sets `replacesMessageId`.
 */
function messageToEvent(
  adapterId: string,
  selfId: string,
  msg: TelegramMessage,
  rawUpdate: TelegramUpdate,
  kindOverride?: "create" | "edit",
  replacesMessageId?: string
): NormalizedInboundEvent {
  const from = msg.from
  const chat = msg.chat
  const chatId = chat.id
  const userId = from?.id ?? chatId // fallback to chatId for channel posts

  const threadId = msg.message_thread_id !== undefined ? String(msg.message_thread_id) : undefined

  const conversationKey = buildConversationKey("telegram", adapterId, String(chatId), threadId)

  const sender = buildPlatformIdentity(adapterId, chatId, {
    id: userId,
    first_name: from?.first_name ?? chat.first_name,
    last_name: from?.last_name ?? chat.last_name,
    username: from?.username ?? chat.username,
  })

  const { selfMentioned, users } = detectMentions(selfId, msg)

  const segments = buildSegments(msg)
  const plainText = segmentsToPlainText(segments)

  const replyTo =
    msg.reply_to_message !== undefined
      ? {
          messageId: String(msg.reply_to_message.message_id),
          snippet: (msg.reply_to_message.text ?? msg.reply_to_message.caption ?? "").slice(0, 100),
        }
      : undefined

  const channelKind: "private" | "group" | "channel" | "thread" =
    chat.type === "private"
      ? "private"
      : chat.type === "channel"
        ? "channel"
        : threadId !== undefined
          ? "thread"
          : "group"

  // Use edit_date when present so dedup on edited messages picks the
  // wall-clock the edit happened, not the original send time.
  const timestamp = (msg.edit_date ?? msg.date) * 1000

  return {
    platform: "telegram",
    adapterId,
    selfId,
    messageId: String(msg.message_id),
    conversationRef: {
      platform: "telegram",
      adapterId,
      chatId: String(chatId),
      messageId: String(msg.message_id),
    },
    conversationKey,
    sender,
    channel: {
      id: conversationKey,
      name: chat.title ?? chat.username ?? chat.first_name,
      kind: channelKind,
      platformChannelId: String(chatId),
    },
    segments,
    plainText,
    replyTo,
    mentions: { selfMentioned, users },
    timestamp,
    raw: rawUpdate,
    kind: kindOverride ?? "create",
    replacesMessageId,
  }
}

/**
 * Project a callback_query into a NormalizedInboundEvent. Inline-button
 * presses look like a fresh user message whose body is the button payload.
 * We synthesise a `messageId` from the callback id so the dedup ledger
 * treats two presses of the same button-press idempotency-wise (Telegram
 * never re-issues a callback_query id for the same press).
 */
function callbackQueryToEvent(
  adapterId: string,
  selfId: string,
  cq: TelegramCallbackQuery,
  rawUpdate: TelegramUpdate
): NormalizedInboundEvent | null {
  // Without an originating message we can't anchor a conversationKey.
  // Inline_message_id-only presses (no chat) fall through to null — they
  // are an admin / bot-management surface we don't subscribe to.
  if (!cq.message) return null

  const msg = cq.message
  const chatId = msg.chat.id
  const threadId = msg.message_thread_id !== undefined ? String(msg.message_thread_id) : undefined
  const conversationKey = buildConversationKey("telegram", adapterId, String(chatId), threadId)

  const sender = buildPlatformIdentity(adapterId, chatId, cq.from)

  const data = cq.data ?? ""
  const segments: MessageSegment[] = data
    ? [{ type: "text", text: data }]
    : [{ type: "text", text: "[callback_query]" }]
  const plainText = segmentsToPlainText(segments)

  const channelKind: "private" | "group" | "channel" | "thread" =
    msg.chat.type === "private"
      ? "private"
      : msg.chat.type === "channel"
        ? "channel"
        : threadId !== undefined
          ? "thread"
          : "group"

  // The synthetic messageId mirrors `tgcq:<callback_query.id>` so dedup
  // can spot a re-delivered callback. Telegram's callback_query.id is
  // globally unique per press.
  const messageId = `tgcq:${cq.id}`

  return {
    platform: "telegram",
    adapterId,
    selfId,
    messageId,
    conversationRef: {
      platform: "telegram",
      adapterId,
      chatId: String(chatId),
      messageId,
      callbackQueryId: cq.id,
    },
    conversationKey,
    sender,
    channel: {
      id: conversationKey,
      name: msg.chat.title ?? msg.chat.username ?? msg.chat.first_name,
      kind: channelKind,
      platformChannelId: String(chatId),
    },
    segments,
    plainText,
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: rawUpdate,
    kind: "create",
  }
}

// ---------------------------------------------------------------------------
// Public parser
// ---------------------------------------------------------------------------

/**
 * Parse a Telegram update envelope into a `NormalizedInboundEvent`.
 *
 * Returns `null` for updates we deliberately ignore:
 * - inline-message-only callback_query (no anchoring chat)
 * - empty / unrecognised update types
 */
export function parseTelegramUpdate(
  adapterId: string,
  selfId: string,
  update: TelegramUpdate
): NormalizedInboundEvent | null {
  // ── Edits (regular chat or channel post) → kind=edit ──────────────────
  if (update.edited_message !== undefined) {
    return messageToEvent(
      adapterId,
      selfId,
      update.edited_message,
      update,
      "edit",
      String(update.edited_message.message_id)
    )
  }
  if (update.edited_channel_post !== undefined) {
    return messageToEvent(
      adapterId,
      selfId,
      update.edited_channel_post,
      update,
      "edit",
      String(update.edited_channel_post.message_id)
    )
  }

  // ── Inline button press → synthetic create event ──────────────────────
  if (update.callback_query !== undefined) {
    return callbackQueryToEvent(adapterId, selfId, update.callback_query, update)
  }

  // ── Regular create paths ──────────────────────────────────────────────
  const msg = update.message ?? update.channel_post
  if (!msg) return null
  return messageToEvent(adapterId, selfId, msg, update)
}
