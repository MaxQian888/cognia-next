/**
 * Telegram update → NormalizedInboundEvent parser.
 *
 * Only handles the subset of update types relevant to Phase 1:
 * - message (text, photo with caption)
 * - edited_message → null (TODO: Phase 2 edit events)
 * - callback_query → null (TODO: Phase 2 interactive flows)
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
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

// ---------------------------------------------------------------------------
// Parser
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
 * Parse a Telegram `result[]` element into a `NormalizedInboundEvent`.
 *
 * Returns `null` for update types not yet handled in Phase 1:
 * - `edited_message` (TODO: Phase 2 edit events)
 * - `callback_query` (TODO: Phase 2 interactive flows)
 */
export function parseTelegramUpdate(
  adapterId: string,
  selfId: string,
  update: TelegramUpdate
): NormalizedInboundEvent | null {
  // TODO (Phase 2): handle edited_message as edit events
  if (update.edited_message !== undefined) return null

  // TODO (Phase 2): handle callback_query for interactive button flows
  if (update.callback_query !== undefined) return null

  const msg = update.message ?? update.channel_post
  if (!msg) return null

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
    timestamp: msg.date * 1000,
    raw: update,
  }
}
