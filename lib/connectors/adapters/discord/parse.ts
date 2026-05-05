/**
 * Discord Gateway dispatch → NormalizedInboundEvent parser.
 *
 * Handles MESSAGE_CREATE in Phase 1.
 * MESSAGE_UPDATE → null (TODO: Phase 2 edit events).
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
 * Parse a Discord Gateway dispatch into a NormalizedInboundEvent.
 *
 * Returns null for:
 * - MESSAGE_UPDATE (TODO: Phase 2)
 * - All non-MESSAGE_CREATE dispatch types
 */
export function parseDiscordDispatch(
  adapterId: string,
  selfId: string,
  dispatch: DiscordDispatch
): NormalizedInboundEvent | null {
  // TODO (Phase 2): handle MESSAGE_UPDATE as edit events
  if (dispatch.t === "MESSAGE_UPDATE") return null

  if (dispatch.t !== "MESSAGE_CREATE") return null

  const msg = dispatch.d as DiscordMessage

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
  }
}
