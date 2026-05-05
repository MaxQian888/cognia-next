/**
 * OneBot v11 event parser.
 *
 * Consumes raw JSON payloads from the reverse-WS connection and projects
 * `message` post_type events into NormalizedInboundEvent. Other post_types
 * (notice, request, meta_event) return null in Phase 1.
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import { segmentsToPlainText } from "@/types/connectors/segment"
import { fromOneBotSegments, parseCqCodeString, type OneBotSegment } from "./segments"

// ---------------------------------------------------------------------------
// Raw event shape (minimal subset we consume)
// ---------------------------------------------------------------------------

export interface OneBotV11Sender {
  user_id: number
  nickname: string
  card?: string
}

export interface OneBotV11Event {
  time: number
  self_id: number
  post_type: "message" | "notice" | "request" | "meta_event"
  message_type?: "private" | "group"
  sub_type?: string
  message_id?: number
  user_id?: number
  group_id?: number
  /** Array format or CQ-code string */
  message?: OneBotSegment[] | string
  raw_message?: string
  sender?: OneBotV11Sender
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function buildSender(adapterId: string, event: OneBotV11Event): PlatformIdentity {
  const userId = event.user_id ?? 0
  const nick = event.sender?.card || event.sender?.nickname || String(userId)

  return {
    id: `onebot:${userId}`,
    platform: "onebot",
    adapterId,
    remoteUserId: String(userId),
    displayName: nick,
    avatarUrl: undefined,
  }
}

function normalizeMessageSegments(message: OneBotSegment[] | string | undefined) {
  if (!message) return []
  if (typeof message === "string") {
    return parseCqCodeString(message, "v11")
  }
  return fromOneBotSegments(message, "v11")
}

/**
 * Parse a raw OneBot v11 event payload into a NormalizedInboundEvent.
 *
 * Returns null for non-message post_types (Phase 1).
 */
export function parseV11Event(
  adapterId: string,
  event: OneBotV11Event
): NormalizedInboundEvent | null {
  if (event.post_type !== "message") return null

  const messageType = event.message_type ?? "private"
  const userId = event.user_id ?? 0
  const groupId = event.group_id ?? 0
  const selfId = String(event.self_id)
  const messageId = String(event.message_id ?? "")

  const chatKey = messageType === "private" ? `p:${userId}` : `g:${groupId}`

  const conversationKey = buildConversationKey("onebot", adapterId, chatKey)

  const sender = buildSender(adapterId, event)

  const segments = normalizeMessageSegments(event.message)
  const plainText = segmentsToPlainText(segments)

  // Mention detection: at-segments targeting selfId
  let selfMentioned = false
  const mentionedUsers: string[] = []
  for (const seg of segments) {
    if (seg.type === "mention") {
      mentionedUsers.push(seg.userId)
      if (seg.userId === selfId) selfMentioned = true
    }
  }

  // Reply detection
  let replyTo: { messageId: string; snippet: string } | undefined
  for (const seg of segments) {
    if (seg.type === "reply") {
      replyTo = { messageId: seg.messageId, snippet: seg.snippet ?? "" }
      break
    }
  }

  const channelKind = messageType === "private" ? "private" : "group"

  return {
    platform: "onebot",
    adapterId,
    selfId,
    messageId,
    conversationRef: {
      platform: "onebot",
      adapterId,
      chatKey,
      messageType,
      groupId: messageType === "group" ? groupId : undefined,
      userId,
    },
    conversationKey,
    sender,
    channel: {
      id: conversationKey,
      kind: channelKind,
      platformChannelId: messageType === "private" ? String(userId) : String(groupId),
    },
    segments,
    plainText,
    replyTo,
    mentions: { selfMentioned, users: mentionedUsers },
    timestamp: event.time * 1000,
    raw: event,
  }
}
