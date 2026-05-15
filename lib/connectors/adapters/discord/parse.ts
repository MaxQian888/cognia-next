/**
 * Discord Gateway dispatch → NormalizedInboundEvent parser.
 *
 * Handles:
 * - MESSAGE_CREATE → kind="create"
 * - MESSAGE_UPDATE → kind="edit"  with `replacesMessageId` set so the bus
 *                     can update the existing StoredMessage in place.
 * - MESSAGE_DELETE → kind="delete" with `replacesMessageId` set; the bus
 *                     soft-deletes the matching StoredMessage. The delete
 *                     dispatch carries no sender / content metadata, so we
 *                     synthesise a thin event using just the channel + ids.
 *
 * All other dispatch types → null.
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"

// ---------------------------------------------------------------------------
// Minimal Discord Gateway types (only the fields we consume)
// ---------------------------------------------------------------------------

export interface DiscordUser {
  id: string
  username: string
  discriminator?: string
  global_name?: string | null
  bot?: boolean
}

export interface DiscordAttachment {
  id: string
  filename: string
  url: string
  proxy_url?: string
  size?: number
  content_type?: string
  width?: number
  height?: number
}

export interface DiscordMessageReference {
  message_id?: string
  channel_id?: string
  guild_id?: string
}

export interface DiscordMessage {
  id: string
  type?: number
  content: string
  channel_id: string
  guild_id?: string
  /** Present when the message is inside a thread. */
  thread_id?: string
  author: DiscordUser
  timestamp: string
  attachments: DiscordAttachment[]
  mentions: DiscordUser[]
  mention_roles?: string[]
  message_reference?: DiscordMessageReference
  referenced_message?: DiscordMessage | null
}

export interface DiscordDispatch {
  /** Dispatch type, e.g. "MESSAGE_CREATE". */
  t: string
  s?: number
  op: number
  d: DiscordMessage | Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function buildPlatformIdentity(adapterId: string, author: DiscordUser): PlatformIdentity {
  const displayName = author.global_name ?? author.username
  return {
    id: `discord:${author.id}`,
    platform: "discord",
    adapterId,
    remoteUserId: author.id,
    displayName,
    avatarUrl: undefined,
  }
}

function detectMentions(
  selfId: string,
  msg: DiscordMessage
): { selfMentioned: boolean; users: string[] } {
  const users: string[] = []
  let selfMentioned = false

  for (const user of msg.mentions) {
    users.push(user.id)
    if (user.id === selfId) {
      selfMentioned = true
    }
  }

  return { selfMentioned, users }
}

function buildSegments(msg: DiscordMessage): MessageSegment[] {
  const segments: MessageSegment[] = []

  // Attachments first; pick image attachments as image segments
  for (const att of msg.attachments) {
    const contentType = att.content_type ?? ""
    if (contentType.startsWith("image/")) {
      segments.push({
        type: "image",
        url: att.url,
        alt: att.filename,
        width: att.width,
        height: att.height,
      })
    } else {
      segments.push({
        type: "file",
        url: att.url,
        name: att.filename,
        mimeType: att.content_type ?? "application/octet-stream",
        sizeBytes: att.size ?? 0,
      })
    }
  }

  if (msg.content) {
    segments.push({ type: "text", text: msg.content })
  }

  return segments
}

/**
 * Project a `MESSAGE_CREATE` / `MESSAGE_UPDATE` payload into the common
 * NormalizedInboundEvent shape. Discord delivers the same `DiscordMessage`
 * envelope on both events; the only difference is whether we tag the
 * resulting event as `create` or `edit` and set `replacesMessageId`.
 */
function messageToEvent(
  adapterId: string,
  selfId: string,
  msg: DiscordMessage,
  dispatch: DiscordDispatch,
  kindOverride?: "create" | "edit"
): NormalizedInboundEvent {
  const channelId = msg.channel_id
  const threadId = msg.thread_id

  const conversationKey = buildConversationKey("discord", adapterId, channelId, threadId)

  const sender = buildPlatformIdentity(adapterId, msg.author)

  const { selfMentioned, users } = detectMentions(selfId, msg)

  const segments = buildSegments(msg)
  const plainText = segmentsToPlainText(segments)

  const replyTo =
    msg.message_reference?.message_id !== undefined
      ? {
          messageId: msg.message_reference.message_id,
          snippet: (msg.referenced_message?.content ?? "").slice(0, 100),
        }
      : undefined

  const channelKind: "private" | "group" | "channel" | "thread" =
    threadId !== undefined ? "thread" : msg.guild_id !== undefined ? "group" : "private"

  return {
    platform: "discord",
    adapterId,
    selfId,
    messageId: msg.id,
    conversationRef: {
      platform: "discord",
      adapterId,
      channelId,
      guildId: msg.guild_id,
      messageId: msg.id,
    },
    conversationKey,
    sender,
    channel: {
      id: conversationKey,
      kind: channelKind,
      platformChannelId: channelId,
    },
    segments,
    plainText,
    replyTo,
    mentions: { selfMentioned, users },
    timestamp: new Date(msg.timestamp).getTime(),
    raw: dispatch,
    kind: kindOverride ?? "create",
    replacesMessageId: kindOverride === "edit" ? msg.id : undefined,
  }
}

/**
 * Project a `MESSAGE_DELETE` payload into a synthetic `kind="delete"`
 * event. Discord's MESSAGE_DELETE only carries `{ id, channel_id, guild_id }`
 * — no author or content — so we set sender / segments to empty stubs and
 * rely on `replacesMessageId` for the bus to find the row to soft-delete.
 */
interface DiscordMessageDeletePayload {
  id: string
  channel_id: string
  guild_id?: string
  thread_id?: string
}

function deleteToEvent(
  adapterId: string,
  selfId: string,
  payload: DiscordMessageDeletePayload,
  dispatch: DiscordDispatch
): NormalizedInboundEvent {
  const channelId = payload.channel_id
  const threadId = payload.thread_id
  const conversationKey = buildConversationKey("discord", adapterId, channelId, threadId)

  const channelKind: "private" | "group" | "channel" | "thread" =
    threadId !== undefined ? "thread" : payload.guild_id !== undefined ? "group" : "private"

  return {
    platform: "discord",
    adapterId,
    selfId,
    messageId: payload.id,
    conversationRef: {
      platform: "discord",
      adapterId,
      channelId,
      guildId: payload.guild_id,
      messageId: payload.id,
    },
    conversationKey,
    // Sender unknown — Discord does not include it on the delete event.
    sender: {
      id: `discord:unknown`,
      platform: "discord",
      adapterId,
      remoteUserId: "unknown",
    },
    channel: {
      id: conversationKey,
      kind: channelKind,
      platformChannelId: channelId,
    },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: dispatch,
    kind: "delete",
    replacesMessageId: payload.id,
  }
}

/**
 * Parse a Discord Gateway dispatch into a NormalizedInboundEvent.
 *
 * Handles MESSAGE_CREATE / MESSAGE_UPDATE / MESSAGE_DELETE; returns null
 * for every other dispatch type (we do not subscribe to typing indicators,
 * presence updates, or guild events).
 */
export function parseDiscordDispatch(
  adapterId: string,
  selfId: string,
  dispatch: DiscordDispatch
): NormalizedInboundEvent | null {
  if (dispatch.t === "MESSAGE_CREATE") {
    return messageToEvent(adapterId, selfId, dispatch.d as DiscordMessage, dispatch)
  }
  if (dispatch.t === "MESSAGE_UPDATE") {
    return messageToEvent(adapterId, selfId, dispatch.d as DiscordMessage, dispatch, "edit")
  }
  if (dispatch.t === "MESSAGE_DELETE") {
    return deleteToEvent(adapterId, selfId, dispatch.d as DiscordMessageDeletePayload, dispatch)
  }
  return null
}
