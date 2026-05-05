/**
 * OneBot v12 event parser.
 *
 * v12 uses `detail_type` instead of `message_type`, `user_id` as string,
 * and the `mention` segment type (instead of `at`) for @-mentions.
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import { segmentsToPlainText } from "@/types/connectors/segment"
import { fromOneBotSegments, type OneBotSegment } from "./segments"

// ---------------------------------------------------------------------------
// Raw event shape (v12)
// ---------------------------------------------------------------------------

export interface OneBotV12Sender {
  user_id: string
  nickname?: string
}

export interface OneBotV12Event {
  id: string
  time: number
  type: "message" | "notice" | "request" | "meta"
  detail_type?: "private" | "group" | "channel"
  sub_type?: string
  message_id?: string
  user_id?: string
  group_id?: string
  self: { platform: string; user_id: string }
  message?: OneBotSegment[]
  alt_message?: string
  sender?: OneBotV12Sender
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function buildSender(adapterId: string, event: OneBotV12Event): PlatformIdentity {
  const userId = event.user_id ?? ""
  const nick = event.sender?.nickname || userId

  return {
    id: `onebot:${userId}`,
    platform: "onebot",
    adapterId,
    remoteUserId: userId,
    displayName: nick,
    avatarUrl: undefined,
  }
}

/**
 * Parse a raw OneBot v12 event payload into a NormalizedInboundEvent.
 *
 * Returns null for non-message event types (Phase 1).
 */
export function parseV12Event(
  adapterId: string,
  event: OneBotV12Event
): NormalizedInboundEvent | null {
  if (event.type !== "message") return null

  const detailType = event.detail_type ?? "private"
  const userId = event.user_id ?? ""
  const groupId = event.group_id ?? ""
  const selfId = event.self.user_id
  const messageId = event.message_id ?? ""

  const chatKey = detailType === "private" ? `p:${userId}` : `g:${groupId}`

  const conversationKey = buildConversationKey("onebot", adapterId, chatKey)

  const sender = buildSender(adapterId, event)

  const segments = event.message ? fromOneBotSegments(event.message, "v12") : []
  const plainText = segmentsToPlainText(segments)

  // Mention detection
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

  const channelKind = detailType === "private" ? "private" : "group"

  return {
    platform: "onebot",
    adapterId,
    selfId,
    messageId,
    conversationRef: {
      platform: "onebot",
      adapterId,
      chatKey,
      detailType,
      groupId: detailType !== "private" ? groupId : undefined,
      userId,
    },
    conversationKey,
    sender,
    channel: {
      id: conversationKey,
      kind: channelKind,
      platformChannelId: detailType === "private" ? userId : groupId,
    },
    segments,
    plainText,
    replyTo,
    mentions: { selfMentioned, users: mentionedUsers },
    timestamp: event.time * 1000,
    raw: event,
  }
}
