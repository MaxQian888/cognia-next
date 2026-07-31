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
  /**
   * `message` is normal inbound, `notice` carries delete/edit notifications.
   * Some implementations also emit `"message_sent"` for the bot's own
   * outbound — we ignore that variant.
   */
  type: "message" | "notice" | "request" | "meta" | "message_sent" | string
  /**
   * For `type === "message"`: chat kind. For `type === "notice"`: the
   * specific notice variant (e.g. `group_message_delete`,
   * `private_message_delete`). OneBot v12 does NOT define a message-edit
   * event — messages are immutable on the wire — so only delete is wired.
   */
  detail_type?: string
  sub_type?: string
  message_id?: string
  user_id?: string
  group_id?: string
  /** Notice-only: the id of the message being deleted. */
  operator_id?: string
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
 * Build a synthetic delete event from a v12 `notice` payload. v12 does
 * not include the deleted message's content on the notice — the bus
 * uses `replacesMessageId` to find the original StoredMessage.
 */
function v12DeleteToEvent(adapterId: string, event: OneBotV12Event): NormalizedInboundEvent | null {
  const messageId = event.message_id
  if (!messageId) return null
  const isGroup = event.detail_type === "group_message_delete"
  const userId = event.user_id ?? ""
  const groupId = event.group_id ?? ""
  const chatKey = isGroup ? `g:${groupId}` : `p:${userId}`
  const conversationKey = buildConversationKey("onebot", adapterId, chatKey)

  return {
    platform: "onebot",
    adapterId,
    selfId: event.self.user_id,
    messageId,
    conversationRef: {
      platform: "onebot",
      adapterId,
      chatKey,
      detailType: isGroup ? "group" : "private",
      groupId: isGroup ? groupId : undefined,
      userId,
    },
    conversationKey,
    sender: {
      id: `onebot:${userId}`,
      platform: "onebot",
      adapterId,
      remoteUserId: userId,
    },
    channel: {
      id: conversationKey,
      kind: isGroup ? "group" : "private",
      platformChannelId: isGroup ? groupId : userId,
    },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: event.time * 1000,
    raw: event,
    kind: "delete",
    replacesMessageId: messageId,
  }
}

/**
 * Parse a raw OneBot v12 event payload into a NormalizedInboundEvent.
 *
 * - `type === "message"`               → kind="create"
 * - `type === "notice"` with detail_type
 *    `group_message_delete` /
 *    `private_message_delete`           → kind="delete"
 * - `type === "message_sent"`          → null (echo of our own send)
 * - everything else                    → null
 */
export function parseV12Event(
  adapterId: string,
  event: OneBotV12Event
): NormalizedInboundEvent | null {
  // ── Echo filter ──────────────────────────────────────────────────────
  if (event.type === "message_sent") return null

  // ── Delete (no edit support — v12 messages are immutable) ────────────
  if (
    event.type === "notice" &&
    (event.detail_type === "group_message_delete" || event.detail_type === "private_message_delete")
  ) {
    return v12DeleteToEvent(adapterId, event)
  }

  // ── Member-change notices → system event (audit-only) ──────────────
  if (event.type === "notice") {
    const systemKind: NormalizedInboundEvent["systemKind"] =
      event.detail_type === "group_member_increase" || event.detail_type === "friend_increase"
        ? "member_added"
        : event.detail_type === "group_member_decrease" || event.detail_type === "friend_decrease"
          ? "member_removed"
          : undefined
    // Unknown notice types stay unhandled (mirrors the v11 parser) — the old
    // "member_added" default fabricated join events for every unrecognised
    // notice.
    if (systemKind === undefined) return null
    const isGroup = (event.detail_type ?? "").startsWith("group_")
    const userId = event.user_id ?? ""
    const groupId = event.group_id ?? ""
    const chatKey = isGroup ? `g:${groupId}` : `p:${userId}`
    const conversationKey = buildConversationKey("onebot", adapterId, chatKey)
    return {
      platform: "onebot",
      adapterId,
      selfId: event.self.user_id,
      messageId: `${event.type}:${event.detail_type ?? "evt"}:${event.id}`,
      conversationRef: {
        platform: "onebot",
        adapterId,
        chatKey,
        detailType: isGroup ? "group" : "private",
        groupId: isGroup ? groupId : undefined,
        userId,
      },
      conversationKey,
      sender: {
        id: `onebot:${userId}`,
        platform: "onebot",
        adapterId,
        remoteUserId: userId,
      },
      channel: {
        id: conversationKey,
        kind: isGroup ? "group" : "private",
        platformChannelId: isGroup ? groupId : userId,
      },
      segments: [],
      plainText: "",
      mentions: { selfMentioned: false, users: [] },
      timestamp: event.time * 1000,
      raw: event,
      kind: "system",
      systemKind,
    }
  }

  // ── Meta events: skip heartbeats; surface lifecycle for audit. ─────
  if (event.type === "meta") {
    // Don't emit anything — the transport-reverse-ws already drives the
    // adapter health state for connect/disconnect; surfacing every meta
    // tick to the bus would balloon the audit log.
    return null
  }

  // ── Request events: friend / group requests — surface as system. ───
  if (event.type === "request") {
    const userId = event.user_id ?? ""
    const chatKey = `p:${userId}`
    const conversationKey = buildConversationKey("onebot", adapterId, chatKey)
    return {
      platform: "onebot",
      adapterId,
      selfId: event.self.user_id,
      messageId: `request:${event.id}`,
      conversationRef: { platform: "onebot", adapterId, chatKey, detailType: "private" },
      conversationKey,
      sender: { id: `onebot:${userId}`, platform: "onebot", adapterId, remoteUserId: userId },
      channel: { id: conversationKey, kind: "private", platformChannelId: userId },
      segments: [],
      plainText: "",
      mentions: { selfMentioned: false, users: [] },
      timestamp: event.time * 1000,
      raw: event,
      kind: "system",
      systemKind: "member_added",
    }
  }

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
