import type { PlatformKind } from "./platform-kind"
import type { MessageSegment } from "./segment"

/**
 * Opaque adapter-owned handle. Persisted on ChatSession.platformBinding
 * so the bus can do proactive outbound via continueConversation. Bus never
 * inspects fields beyond `platform` + `adapterId`.
 */
export interface ConversationReference {
  platform: PlatformKind
  adapterId: string
  [k: string]: unknown
}

export interface PlatformIdentity {
  /** Stable local id; same person across platforms after merge. */
  id: string
  platform: PlatformKind
  adapterId: string
  /** Platform-native user id (Telegram int, Discord snowflake, etc.) as string. */
  remoteUserId: string
  displayName?: string
  avatarUrl?: string
  mergedFromIds?: string[]
}

export type ChannelKind = "private" | "group" | "channel" | "thread"

export interface ChannelDescriptor {
  /** Bus-level channel id; unique per (platform, adapterId). */
  id: string
  name?: string
  kind: ChannelKind
  /** The platform-native channel id, kept verbatim for the adapter's use. */
  platformChannelId?: string
}

export interface ReplyDescriptor {
  messageId: string
  snippet: string
}

export interface MentionDescriptor {
  selfMentioned: boolean
  users: string[]
}

export interface NormalizedInboundEvent {
  platform: PlatformKind
  adapterId: string
  selfId: string
  messageId: string
  conversationRef: ConversationReference
  conversationKey: string
  sender: PlatformIdentity
  channel: ChannelDescriptor
  segments: MessageSegment[]
  plainText: string
  replyTo?: ReplyDescriptor
  mentions: MentionDescriptor
  timestamp: number
  raw: unknown
  channelData?: Record<string, unknown>
}

const KEY_SEP = ":"

export function buildConversationKey(
  platform: PlatformKind,
  adapterId: string,
  remoteChatId: string,
  threadId?: string
): string {
  const base = [platform, adapterId, remoteChatId].join(KEY_SEP)
  return threadId ? `${base}${KEY_SEP}${threadId}` : base
}

export interface ParsedConversationKey {
  platform: PlatformKind
  adapterId: string
  remoteChatId: string
  threadId: string | undefined
}

export function parseConversationKey(key: string): ParsedConversationKey {
  const parts = key.split(KEY_SEP)
  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error(`invalid conversationKey: ${key}`)
  }
  return {
    platform: parts[0] as PlatformKind,
    adapterId: parts[1],
    remoteChatId: parts[2],
    threadId: parts[3],
  }
}
