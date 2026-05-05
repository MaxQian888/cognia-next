/**
 * Lark event-subscription envelope → NormalizedInboundEvent parser.
 *
 * Handles im.message.receive_v1 events (schema 2.0).
 * Returns null for unsupported event types.
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"

// ---------------------------------------------------------------------------
// Lark event envelope types
// ---------------------------------------------------------------------------

export interface LarkMentionId {
  open_id?: string
  user_id?: string
}

export interface LarkMention {
  key: string
  id: LarkMentionId
  name?: string
}

export interface LarkSenderId {
  open_id?: string
  user_id?: string
}

export interface LarkSender {
  sender_id: LarkSenderId
  sender_type?: string
  tenant_key?: string
}

export interface LarkMessage {
  message_id: string
  chat_id: string
  chat_type: "p2p" | "group"
  message_type: string
  content: string
  mentions?: LarkMention[]
  create_time?: string
  thread_id?: string | null
}

export interface LarkEventHeader {
  event_id: string
  event_type: string
  create_time?: string
  token?: string
  app_id?: string
}

export interface LarkEventBody {
  sender: LarkSender
  message: LarkMessage
}

export interface LarkEventEnvelope {
  schema?: string
  header: LarkEventHeader
  event: LarkEventBody
}

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

function buildPlatformIdentity(adapterId: string, openId: string): PlatformIdentity {
  return {
    id: `lark:${openId}`,
    platform: "lark",
    adapterId,
    remoteUserId: openId,
    displayName: undefined,
    avatarUrl: undefined,
  }
}

function detectMentions(
  selfBotOpenId: string,
  message: LarkMessage
): { selfMentioned: boolean; users: string[] } {
  const users: string[] = []
  let selfMentioned = false

  for (const mention of message.mentions ?? []) {
    const mentionOpenId = mention.id?.open_id
    if (mentionOpenId) {
      if (!users.includes(mentionOpenId)) {
        users.push(mentionOpenId)
      }
      if (mentionOpenId === selfBotOpenId) {
        selfMentioned = true
      }
    }
  }

  return { selfMentioned, users }
}

function buildSegments(message: LarkMessage): MessageSegment[] {
  const segments: MessageSegment[] = []

  try {
    const parsed = JSON.parse(message.content) as Record<string, unknown>

    switch (message.message_type) {
      case "text": {
        const text = typeof parsed["text"] === "string" ? parsed["text"] : ""
        if (text) {
          segments.push({ type: "text", text })
        }
        break
      }

      case "image": {
        const imageKey = typeof parsed["image_key"] === "string" ? parsed["image_key"] : ""
        if (imageKey) {
          segments.push({
            type: "image",
            url: imageKey,
            alt: "image",
          })
        }
        break
      }

      case "post":
      case "file":
      case "audio":
      case "video":
      case "sticker": {
        // Phase 1: represent as text with the raw type label
        segments.push({ type: "text", text: `[${message.message_type}]` })
        break
      }

      default:
        break
    }
  } catch {
    // Malformed content — return empty segments
  }

  return segments
}

/**
 * Parse a Lark event-subscription envelope into a NormalizedInboundEvent.
 *
 * Returns null for:
 * - Non-im.message.receive_v1 event types (TODO: member-changes, read-indicators, etc.)
 * - Missing sender open_id
 */
export function parseLarkEventEnvelope(
  adapterId: string,
  selfBotOpenId: string,
  envelope: LarkEventEnvelope
): NormalizedInboundEvent | null {
  const eventType = envelope.header?.event_type

  if (eventType !== "im.message.receive_v1") {
    // TODO: handle im.message.read_v1, member changes, etc. in Phase 2
    return null
  }

  const { sender, message } = envelope.event

  const openId = sender?.sender_id?.open_id
  if (!openId) return null

  const chatId = message.chat_id
  const threadId = message.thread_id ?? undefined

  const conversationKey = buildConversationKey("lark", adapterId, chatId, threadId)
  const senderIdentity = buildPlatformIdentity(adapterId, openId)
  const { selfMentioned, users } = detectMentions(selfBotOpenId, message)
  const segments = buildSegments(message)
  const plainText = segmentsToPlainText(segments)

  const channelKind: "private" | "group" | "thread" =
    threadId !== undefined ? "thread" : message.chat_type === "p2p" ? "private" : "group"

  const createTimeMs = message.create_time ? parseInt(message.create_time, 10) : Date.now()

  return {
    platform: "lark",
    adapterId,
    selfId: selfBotOpenId,
    messageId: message.message_id,
    conversationRef: {
      platform: "lark",
      adapterId,
      channelId: chatId,
      threadTs: threadId,
    },
    conversationKey,
    sender: senderIdentity,
    channel: {
      id: conversationKey,
      kind: channelKind,
      platformChannelId: chatId,
    },
    segments,
    plainText,
    replyTo: undefined,
    mentions: { selfMentioned, users },
    timestamp: createTimeMs,
    raw: envelope,
  }
}
