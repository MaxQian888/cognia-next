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
  /**
   * `message` is normal inbound, `notice` carries recall events,
   * `message_sent` is the bot's own echo (we ignore it). go-cqhttp also
   * uses the literal string `"message_sent"` here even though the OneBot
   * spec only defines four post_types — keep it stringly-typed for safety.
   */
  post_type: "message" | "notice" | "request" | "meta_event" | "message_sent" | string
  message_type?: "private" | "group"
  /** Notice subtype — `group_recall` / `friend_recall` map to delete events. */
  notice_type?: string
  sub_type?: string
  message_id?: number
  user_id?: number
  group_id?: number
  /** Notice-only: id of the message being recalled. */
  recalled_message_id?: number
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
 * Build a synthetic system event for non-message OneBot v11 notices —
 * member added/removed, friend add request, group join request,
 * lifecycle, heartbeat. The bus consumes these only at the audit layer
 * (no StoredMessage written), so the segments stay empty and the
 * payload's full shape lives in `raw`.
 */
function v11SystemEvent(
  adapterId: string,
  event: OneBotV11Event,
  systemKind: NonNullable<NormalizedInboundEvent["systemKind"]>
): NormalizedInboundEvent {
  const isGroup = event.group_id !== undefined && event.group_id !== 0
  const userId = event.user_id ?? 0
  const groupId = event.group_id ?? 0
  const chatKey = isGroup ? `g:${groupId}` : `p:${userId}`
  const conversationKey = buildConversationKey("onebot", adapterId, chatKey)
  return {
    platform: "onebot",
    adapterId,
    selfId: String(event.self_id),
    messageId: `${event.post_type}:${event.notice_type ?? event.sub_type ?? "evt"}:${event.time}:${userId}`,
    conversationRef: {
      platform: "onebot",
      adapterId,
      chatKey,
      messageType: isGroup ? "group" : "private",
      groupId: isGroup ? groupId : undefined,
      userId,
    },
    conversationKey,
    sender: {
      id: `onebot:${userId}`,
      platform: "onebot",
      adapterId,
      remoteUserId: String(userId),
    },
    channel: {
      id: conversationKey,
      kind: isGroup ? "group" : "private",
      platformChannelId: isGroup ? String(groupId) : String(userId),
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

/**
 * Build a synthetic delete event from a v11 `notice` recall payload.
 * `group_recall` carries `message_id` (and optionally `group_id`);
 * `friend_recall` carries `message_id` and `user_id`. We don't have full
 * sender / segment metadata on a recall — the bus only needs
 * `replacesMessageId` + `conversationKey` to soft-delete the row.
 */
function v11RecallToEvent(adapterId: string, event: OneBotV11Event): NormalizedInboundEvent | null {
  // Some implementations put the id under `message_id`; others under
  // `recalled_message_id`. Accept both.
  const recalledId = event.recalled_message_id ?? event.message_id
  if (recalledId === undefined) return null
  const isGroup = event.notice_type === "group_recall"
  const userId = event.user_id ?? 0
  const groupId = event.group_id ?? 0
  const chatKey = isGroup ? `g:${groupId}` : `p:${userId}`
  const conversationKey = buildConversationKey("onebot", adapterId, chatKey)

  return {
    platform: "onebot",
    adapterId,
    selfId: String(event.self_id),
    messageId: String(recalledId),
    conversationRef: {
      platform: "onebot",
      adapterId,
      chatKey,
      messageType: isGroup ? "group" : "private",
      groupId: isGroup ? groupId : undefined,
      userId,
    },
    conversationKey,
    sender: {
      id: `onebot:${userId}`,
      platform: "onebot",
      adapterId,
      remoteUserId: String(userId),
    },
    channel: {
      id: conversationKey,
      kind: isGroup ? "group" : "private",
      platformChannelId: isGroup ? String(groupId) : String(userId),
    },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: event.time * 1000,
    raw: event,
    kind: "delete",
    replacesMessageId: String(recalledId),
  }
}

/**
 * Parse a raw OneBot v11 event payload into a NormalizedInboundEvent.
 *
 * - `post_type === "message"`           → kind="create"
 * - `post_type === "notice"` with
 *    notice_type=group_recall|friend_recall → kind="delete"
 * - `post_type === "message_sent"`      → null (echo of our own send)
 * - everything else                     → null
 */
export function parseV11Event(
  adapterId: string,
  event: OneBotV11Event
): NormalizedInboundEvent | null {
  // ── Echo filter — bot's own outbound replays as message_sent in
  // go-cqhttp. We never want to treat it as inbound.
  if (event.post_type === "message_sent") return null

  // ── Recall (delete) ──────────────────────────────────────────────────
  if (
    event.post_type === "notice" &&
    (event.notice_type === "group_recall" || event.notice_type === "friend_recall")
  ) {
    return v11RecallToEvent(adapterId, event)
  }

  // ── Notice (member changes, friend additions) → system event ─────────
  if (event.post_type === "notice") {
    switch (event.notice_type) {
      case "group_increase":
      case "friend_add":
        return v11SystemEvent(adapterId, event, "member_added")
      case "group_decrease":
        return v11SystemEvent(adapterId, event, "member_removed")
      case "group_msg_emoji_like":
        // Custom OneBot v11 extension — emoji reaction on a message.
        return v11SystemEvent(adapterId, event, "reaction_added")
      case "poke":
        // NapCat surfaces poke (戳一戳) directly under notice_type.
        return v11SystemEvent(adapterId, event, "poke")
      case "notify":
        // go-cqhttp nests poke under notice_type:"notify" sub_type:"poke"
        // (other notify sub_types — honor, lucky_king — stay unhandled).
        if (event.sub_type === "poke") {
          return v11SystemEvent(adapterId, event, "poke")
        }
        return null
      default:
        // Unknown notice types stay unhandled rather than producing
        // misleading system events. The bus's `unknown.notice` audit
        // covers them when the transport's audit hooks run.
        return null
    }
  }

  // ── Request (friend / group join request) → audit-only system event ──
  if (event.post_type === "request") {
    return v11SystemEvent(adapterId, event, "member_added")
  }

  // ── Meta event (lifecycle / heartbeat) ──────────────────────────────
  // The OneBot adapter's reverse-WS transport already tracks heartbeats
  // for connection health; we surface lifecycle "enable" / "disable"
  // events as system events so the audit log records them.
  if (event.post_type === "meta_event") {
    if (
      event.sub_type === "enable" ||
      event.sub_type === "disable" ||
      event.sub_type === "connect"
    ) {
      return v11SystemEvent(adapterId, event, "member_added")
    }
    // heartbeat / unknown meta_events are too noisy to log per-tick.
    return null
  }

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
