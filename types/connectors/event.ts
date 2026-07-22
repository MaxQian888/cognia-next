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

/**
 * Stable, platform-neutral identity for an IM conversation scope.
 *
 * `conversationKey` remains the durable lookup key, but core connector code
 * treats it as opaque. Adapters provide the structured container/topic fields
 * so delivery, history, and presentation never need to reverse-engineer the
 * key string.
 */
export interface ConversationAddress {
  conversationKey: string
  platform: PlatformKind
  adapterId: string
  scopeKind: ChannelKind
  containerId: string
  topicId?: string
}

/** A refreshed, sendable target for one stable conversation address. */
export interface ConversationDeliveryTarget {
  address: ConversationAddress
  conversationRef: ConversationReference
  sourceMessageId?: string
  refreshedAt: number
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
  /** Sender class as reported by the adapter; omitted for legacy human rows. */
  kind?: "human" | "bot" | "system"
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

/**
 * What this event represents on the wire. Most adapter parsers emit
 * `"create"` (default when omitted, for backward compatibility with rows
 * persisted before Phase 2). `"edit"` and `"delete"` are emitted by adapters
 * that surface platform-side message edits / deletes (Telegram
 * `edited_message`, Discord `MESSAGE_UPDATE` / `MESSAGE_DELETE`, OneBot v12
 * `message.event.edit` / `message.event.delete`, etc.). The bus uses the
 * variant to choose between insert / update-in-place / soft-delete on the
 * existing `StoredMessage`. `"system"` covers non-message bookkeeping events
 * (Lark read-indicators, member-joined / member-removed) that produce an
 * audit row but no message persistence.
 */
export type InboundEventKind = "create" | "edit" | "delete" | "system"

export interface NormalizedInboundEvent {
  platform: PlatformKind
  adapterId: string
  selfId: string
  messageId: string
  conversationRef: ConversationReference
  conversationKey: string
  /** Structured address supplied by adapters that support scoped delivery. */
  conversationAddress?: ConversationAddress
  sender: PlatformIdentity
  channel: ChannelDescriptor
  segments: MessageSegment[]
  plainText: string
  replyTo?: ReplyDescriptor
  mentions: MentionDescriptor
  timestamp: number
  raw: unknown
  channelData?: Record<string, unknown>
  /**
   * Defaults to `"create"` when omitted, preserving the Phase 1 contract.
   * See {@link InboundEventKind}.
   */
  kind?: InboundEventKind
  /**
   * The platform-native message id this event mutates. Required when
   * `kind === "edit"` or `kind === "delete"` so the bus can find the
   * existing `StoredMessage` to update / soft-delete. Ignored on `"create"`
   * and `"system"` events.
   */
  replacesMessageId?: string
  /**
   * Sub-kind for `kind === "system"` bookkeeping events so the audit log
   * can distinguish read-indicators, member-joined, member-removed, and
   * future variants without a string-typing free-for-all. Ignored on
   * non-system events.
   */
  systemKind?:
    | "read_indicator"
    | "member_added"
    | "member_removed"
    | "reaction_added"
    | "reaction_removed"
    | "poke"
    // Friend/group join REQUEST (OneBot `post_type:"request"`). Bookkeeping
    // only — must NOT be conflated with `member_added`, which drives the
    // welcome-card flow.
    | "request"
    // Transport lifecycle marker (OneBot meta_event enable/disable/connect).
    // Bookkeeping only, same caveat as `request`.
    | "lifecycle"
}

/** Build the complete target that must be persisted for later outbound use. */
export function deliveryTargetFromEvent(event: NormalizedInboundEvent): ConversationDeliveryTarget {
  const address =
    event.conversationAddress ??
    ({
      conversationKey: event.conversationKey,
      platform: event.platform,
      adapterId: event.adapterId,
      scopeKind: event.channel.kind,
      containerId: event.channel.platformChannelId ?? event.channel.id,
      ...(event.channel.kind === "thread" ? { topicId: event.channel.id } : {}),
    } satisfies ConversationAddress)
  return {
    address,
    conversationRef: event.conversationRef,
    sourceMessageId: event.messageId,
    refreshedAt: event.timestamp,
  }
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
  if (parts.length < 3 || !parts[0] || !parts[1]) {
    throw new Error(`invalid conversationKey: ${key}`)
  }
  const platform = parts[0] as PlatformKind
  const adapterId = parts[1]
  const rest = parts.slice(2)
  if (rest.length === 1) {
    return { platform, adapterId, remoteChatId: rest[0], threadId: undefined }
  }
  // Chat ids may themselves contain the separator — Matrix room ids are
  // `!local:server[:port]` — so a trailing segment is only split off as a
  // thread id when it is unambiguous. Matrix thread roots are `$`-prefixed
  // event ids; on Matrix everything else belongs to the room id. Other
  // platforms keep the historical shapes: 4 segments = chat id + thread id,
  // and anything longer folds the extra separators back into the chat id.
  const last = rest[rest.length - 1]
  if (platform === "matrix") {
    if (rest.length > 1 && last.startsWith("$")) {
      return {
        platform,
        adapterId,
        remoteChatId: rest.slice(0, -1).join(KEY_SEP),
        threadId: last,
      }
    }
    return { platform, adapterId, remoteChatId: rest.join(KEY_SEP), threadId: undefined }
  }
  if (rest.length === 2) {
    return { platform, adapterId, remoteChatId: rest[0], threadId: rest[1] }
  }
  return { platform, adapterId, remoteChatId: rest.join(KEY_SEP), threadId: undefined }
}
