/**
 * Slack Events API event_callback → NormalizedInboundEvent parser.
 *
 * Handles message events in Phase 1.
 * Ignores bot_message / message_changed subtypes.
 * Returns null for unsupported event types.
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"

// ---------------------------------------------------------------------------
// Minimal Slack Events API types (only fields we consume)
// ---------------------------------------------------------------------------

export interface SlackFile {
  id: string
  name: string
  mimetype: string
  url_private: string
  size?: number
  original_w?: number
  original_h?: number
}

export interface SlackBlock {
  type: string
  elements?: SlackBlockElement[]
}

export interface SlackBlockElement {
  type: string
  user_id?: string
  elements?: SlackBlockElement[]
}

export interface SlackMessageEvent {
  type: string
  channel: string
  user?: string
  text?: string
  ts: string
  thread_ts?: string
  channel_type?: string
  subtype?: string
  files?: SlackFile[]
  blocks?: SlackBlock[]
}

export interface SlackEventEnvelope {
  type: string
  event: SlackMessageEvent
  event_id?: string
  event_time?: number
  team_id?: string
  api_app_id?: string
}

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

function buildPlatformIdentity(adapterId: string, userId: string): PlatformIdentity {
  return {
    id: `slack:${userId}`,
    platform: "slack",
    adapterId,
    remoteUserId: userId,
    displayName: undefined,
    avatarUrl: undefined,
  }
}

function detectMentions(
  selfId: string,
  event: SlackMessageEvent
): { selfMentioned: boolean; users: string[] } {
  const users: string[] = []
  let selfMentioned = false

  // Check plain text for <@USERID> mentions
  const text = event.text ?? ""
  const mentionRegex = /<@([A-Z0-9]+)>/g
  let match: RegExpExecArray | null
  while ((match = mentionRegex.exec(text)) !== null) {
    const userId = match[1]
    if (!users.includes(userId)) {
      users.push(userId)
    }
    if (userId === selfId) {
      selfMentioned = true
    }
  }

  // Also scan blocks for rich_text mention elements
  if (event.blocks) {
    const scanElements = (elements: SlackBlockElement[]) => {
      for (const el of elements) {
        if (el.type === "user" && el.user_id) {
          if (!users.includes(el.user_id)) {
            users.push(el.user_id)
          }
          if (el.user_id === selfId) {
            selfMentioned = true
          }
        }
        if (el.elements) {
          scanElements(el.elements)
        }
      }
    }
    for (const block of event.blocks) {
      if (block.elements) {
        scanElements(block.elements)
      }
    }
  }

  return { selfMentioned, users }
}

function buildSegments(event: SlackMessageEvent): MessageSegment[] {
  const segments: MessageSegment[] = []

  // Image files first
  if (event.files) {
    for (const file of event.files) {
      if (file.mimetype.startsWith("image/")) {
        segments.push({
          type: "image",
          url: file.url_private,
          alt: file.name,
          width: file.original_w,
          height: file.original_h,
        })
      } else {
        segments.push({
          type: "file",
          url: file.url_private,
          name: file.name,
          mimeType: file.mimetype,
          sizeBytes: file.size ?? 0,
        })
      }
    }
  }

  if (event.text) {
    segments.push({ type: "text", text: event.text })
  }

  return segments
}

/**
 * Parse a Slack Events API event_callback envelope into a NormalizedInboundEvent.
 *
 * Returns null for:
 * - Non-message event types
 * - bot_message subtype
 * - message_changed subtype
 */
export function parseSlackEventCallback(
  adapterId: string,
  selfId: string,
  envelope: SlackEventEnvelope
): NormalizedInboundEvent | null {
  if (envelope.type !== "event_callback") return null

  const event = envelope.event
  if (event.type !== "message") return null

  // Ignore bot messages and message edits in Phase 1
  if (event.subtype === "bot_message" || event.subtype === "message_changed") return null

  const userId = event.user
  if (!userId) return null

  const channel = event.channel
  const threadTs = event.thread_ts !== event.ts ? event.thread_ts : undefined

  const conversationKey = buildConversationKey("slack", adapterId, channel, threadTs)
  const sender = buildPlatformIdentity(adapterId, userId)
  const { selfMentioned, users } = detectMentions(selfId, event)
  const segments = buildSegments(event)
  const plainText = segmentsToPlainText(segments)

  const channelType = event.channel_type
  const channelKind: "private" | "group" | "channel" | "thread" =
    threadTs !== undefined
      ? "thread"
      : channelType === "im"
        ? "private"
        : channelType === "group"
          ? "group"
          : "channel"

  return {
    platform: "slack",
    adapterId,
    selfId,
    messageId: event.ts,
    conversationRef: {
      platform: "slack",
      adapterId,
      channelId: channel,
      threadTs: threadTs,
    },
    conversationKey,
    sender,
    channel: {
      id: conversationKey,
      kind: channelKind,
      platformChannelId: channel,
    },
    segments,
    plainText,
    replyTo: undefined,
    mentions: { selfMentioned, users },
    timestamp: Math.round(parseFloat(event.ts) * 1000),
    raw: envelope,
  }
}
