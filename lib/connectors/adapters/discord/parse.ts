/**
 * Discord Gateway dispatch → NormalizedInboundEvent parser.
 *
 * Handles:
 * - MESSAGE_CREATE           → kind="create"
 * - MESSAGE_UPDATE           → kind="edit"  with `replacesMessageId` set
 * - MESSAGE_DELETE           → kind="delete" with `replacesMessageId` set
 * - MESSAGE_REACTION_ADD     → kind="system" with systemKind="reaction_added"
 * - MESSAGE_REACTION_REMOVE  → kind="system" with systemKind="reaction_removed"
 * - INTERACTION_CREATE       → routed through `parseDiscordInteraction` to
 *                              the ConnectorBus callback channel (NOT
 *                              messageToEvent). Components (buttons / select
 *                              menus) and modal_submits both flow through.
 *
 * Native media coverage (G3.2): images / files (existing) + voice (audio
 * attachments) + video attachments + Discord stickers (sticker_items) +
 * locations (carried in embeds rather than a top-level field).
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"
import { MentionAccumulator } from "@/lib/connectors/adapters/_shared/mention-extractor"
import type {
  ConnectorCallbackActionType,
  ConnectorCallbackEvent,
} from "@/types/connectors/interaction"

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

export interface DiscordMember {
  user?: DiscordUser
  nick?: string | null
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
  duration_secs?: number
  waveform?: string
}

export interface DiscordMessageReference {
  message_id?: string
  channel_id?: string
  guild_id?: string
}

export interface DiscordSticker {
  id: string
  name: string
  format_type?: number
}

export interface DiscordEmbed {
  type?: string
  title?: string
  description?: string
  url?: string
  /** Discord uses `embed.type === "link"` with provider for locations. */
  provider?: { name?: string; url?: string }
}

export interface DiscordMessage {
  id: string
  type?: number
  content: string
  /**
   * Channel the message was posted in. For thread messages this IS the
   * thread's channel id — Discord does not ship a separate `thread_id`
   * field on message payloads.
   */
  channel_id: string
  guild_id?: string
  author: DiscordUser
  member?: DiscordMember
  timestamp: string
  attachments: DiscordAttachment[]
  mentions: DiscordUser[]
  mention_roles?: string[]
  message_reference?: DiscordMessageReference
  referenced_message?: DiscordMessage | null
  sticker_items?: DiscordSticker[]
  embeds?: DiscordEmbed[]
}

export interface DiscordReactionEmoji {
  id?: string | null
  name?: string | null
  animated?: boolean
}

export interface DiscordReactionDispatch {
  user_id: string
  channel_id: string
  message_id: string
  guild_id?: string
  member?: DiscordMember
  emoji: DiscordReactionEmoji
}

export interface DiscordInteractionData {
  /** Component custom_id (button, select_menu). */
  custom_id?: string
  /** Component type: 2 = button, 3 = select_menu, etc. */
  component_type?: number
  /** Select menu values; first entry is the canonical `value`. */
  values?: string[]
  /** Modal_submit: nested rows of {custom_id, value} components. */
  components?: Array<{
    components?: Array<{ custom_id?: string; value?: string }>
  }>
}

export interface DiscordInteraction {
  /** 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT, 5=MODAL_SUBMIT */
  type: number
  id: string
  application_id: string
  token: string
  user?: DiscordUser
  member?: DiscordMember
  channel_id?: string
  guild_id?: string
  message?: DiscordMessage
  data?: DiscordInteractionData
}

export interface DiscordDispatch {
  /** Dispatch type, e.g. "MESSAGE_CREATE". */
  t: string
  s?: number
  op: number
  d: unknown
}

// ---------------------------------------------------------------------------
// Parser helpers
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
  const acc = new MentionAccumulator(selfId)
  for (const user of msg.mentions) acc.add(user.id)
  return acc.finalize()
}

function buildSegments(msg: DiscordMessage): MessageSegment[] {
  const segments: MessageSegment[] = []

  // Discord stickers — surface name as emoji code.
  for (const sticker of msg.sticker_items ?? []) {
    segments.push({ type: "emoji", code: sticker.name })
  }

  // Role mentions (ADR-0009 v41 / A2). Discord ships these as a top-level
  // `mention_roles: string[]` array on the message; the user-id placeholders
  // also embed `<@&{role_id}>` tokens inside `content`, but rather than
  // re-parse those tokens we surface each id as a `kind:"role"` mention
  // segment alongside the regular user-mention segments built downstream.
  for (const roleId of msg.mention_roles ?? []) {
    segments.push({ type: "mention", userId: roleId, kind: "role" })
  }

  // Attachments: discriminate image / audio / video / generic file.
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
    } else if (contentType.startsWith("audio/")) {
      // Discord voice messages are audio attachments with `duration_secs`.
      segments.push({
        type: "voice",
        url: att.url,
        durationSec: att.duration_secs,
      })
    } else if (contentType.startsWith("video/")) {
      segments.push({
        type: "video",
        url: att.url,
        durationSec: att.duration_secs,
      })
    } else {
      segments.push({
        type: "file",
        url: att.url,
        name: att.filename,
        mimeType: contentType || "application/octet-stream",
        sizeBytes: att.size ?? 0,
      })
    }
  }

  // Embeds — surface locations (Google Maps / OSM links Discord auto-expands).
  for (const embed of msg.embeds ?? []) {
    if (
      (embed.type === "link" || embed.type === "rich") &&
      (embed.provider?.name === "Google Maps" || embed.url?.includes("maps."))
    ) {
      const desc = embed.title ?? embed.description ?? embed.url
      if (desc) segments.push({ type: "text", text: `📍 ${desc}` })
    }
  }

  if (msg.content) {
    segments.push({ type: "text", text: msg.content })
  }

  return segments
}

/**
 * Project a `MESSAGE_CREATE` / `MESSAGE_UPDATE` payload into the common
 * NormalizedInboundEvent shape.
 */
function messageToEvent(
  adapterId: string,
  selfId: string,
  msg: DiscordMessage,
  dispatch: DiscordDispatch,
  kindOverride?: "create" | "edit"
): NormalizedInboundEvent {
  const channelId = msg.channel_id

  const conversationKey = buildConversationKey("discord", adapterId, channelId)

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

  // Thread messages arrive with `channel_id` set to the thread's own id and
  // no thread marker on the message payload (`thread_id` is not a real
  // Discord field — the old read here was dead), so guild traffic classifies
  // as "group" and DMs as "private". Distinguishing real threads would need
  // channel metadata (GUILD_CREATE cache or a REST channel fetch).
  const channelKind: "private" | "group" | "channel" | "thread" =
    msg.guild_id !== undefined ? "group" : "private"

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

interface DiscordMessageDeletePayload {
  id: string
  channel_id: string
  guild_id?: string
}

function deleteToEvent(
  adapterId: string,
  selfId: string,
  payload: DiscordMessageDeletePayload,
  dispatch: DiscordDispatch
): NormalizedInboundEvent {
  const channelId = payload.channel_id
  const conversationKey = buildConversationKey("discord", adapterId, channelId)

  // Same rationale as messageToEvent: MESSAGE_DELETE carries only
  // id / channel_id / guild_id — there is no `thread_id` field.
  const channelKind: "private" | "group" | "channel" | "thread" =
    payload.guild_id !== undefined ? "group" : "private"

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
 * Project a reaction dispatch into a system event. Discord delivers
 * one MESSAGE_REACTION_ADD / MESSAGE_REACTION_REMOVE per emoji change, so
 * the projection is a 1-to-1 map.
 */
function reactionToEvent(
  adapterId: string,
  selfId: string,
  payload: DiscordReactionDispatch,
  dispatch: DiscordDispatch,
  isAdd: boolean
): NormalizedInboundEvent | null {
  const channelId = payload.channel_id
  const conversationKey = buildConversationKey("discord", adapterId, channelId)
  const senderId = payload.user_id
  const sender: PlatformIdentity = {
    id: `discord:${senderId}`,
    platform: "discord",
    adapterId,
    remoteUserId: senderId,
    displayName: payload.member?.nick ?? payload.member?.user?.global_name ?? undefined,
  }
  const emojiCode = payload.emoji.id ? `custom:${payload.emoji.id}` : (payload.emoji.name ?? "?")
  const channelKind: "private" | "group" | "channel" | "thread" =
    payload.guild_id !== undefined ? "group" : "private"
  return {
    platform: "discord",
    adapterId,
    selfId,
    messageId: `dcreact:${payload.message_id}:${senderId}:${emojiCode}:${isAdd ? "add" : "rm"}`,
    conversationRef: {
      platform: "discord",
      adapterId,
      channelId,
      guildId: payload.guild_id,
      messageId: payload.message_id,
    },
    conversationKey,
    sender,
    channel: { id: conversationKey, kind: channelKind, platformChannelId: channelId },
    segments: [{ type: "emoji", code: emojiCode }],
    plainText: payload.emoji.name ?? "[reaction]",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: dispatch,
    kind: "system",
    systemKind: isAdd ? "reaction_added" : "reaction_removed",
    replacesMessageId: payload.message_id,
  }
}

// ---------------------------------------------------------------------------
// INTERACTION_CREATE → ConnectorCallbackEvent (G4 channel)
// ---------------------------------------------------------------------------

/**
 * Project a Discord INTERACTION_CREATE dispatch into a
 * `ConnectorCallbackEvent` suitable for
 * `ConnectorBus.dispatchConnectorCallback`. Handles:
 *
 *   - type 3 (MESSAGE_COMPONENT): button click (component_type=2),
 *     select menu (component_type=3), etc.
 *   - type 5 (MODAL_SUBMIT): collects all `data.components[][].value`
 *     into the `payload` field.
 *
 * Returns null for application commands (type 2) — we don't subscribe.
 */
export function parseDiscordInteraction(
  adapterId: string,
  selfId: string,
  dispatch: DiscordDispatch
): ConnectorCallbackEvent | null {
  if (dispatch.t !== "INTERACTION_CREATE") return null
  const interaction = dispatch.d as DiscordInteraction
  if (interaction.type !== 3 && interaction.type !== 5) return null
  const channelId = interaction.channel_id
  if (!channelId) return null
  const user = interaction.user ?? interaction.member?.user
  if (!user) return null

  const conversationKey = buildConversationKey("discord", adapterId, channelId)
  const sender = buildPlatformIdentity(adapterId, user)
  const data = interaction.data ?? {}

  let actionType: ConnectorCallbackActionType
  let value = ""
  let payload: Record<string, unknown> | undefined
  if (interaction.type === 5) {
    actionType = "submit"
    payload = collectModalValues(data)
  } else if (data.component_type === 3) {
    actionType = "select"
    value = data.values?.[0] ?? ""
    if (data.values && data.values.length > 1) {
      payload = { values: data.values }
    }
  } else {
    actionType = "button"
    value = data.custom_id ?? ""
  }

  // Telegram-style: prefer the custom_id as the trigger key so the bus
  // can look up the binding row. Fall back to the interaction id when
  // the platform omitted custom_id (rare).
  const triggerId = data.custom_id ?? interaction.id

  return {
    platform: "discord",
    adapterId,
    selfId,
    triggerId,
    surfaceId: "", // resolved by ConnectorBus via the binding row.
    componentId: undefined,
    actionType,
    value,
    payload,
    originatingMessageId: interaction.message?.id,
    conversationKey,
    user: sender,
    timestamp: Date.now(),
    raw: dispatch,
  }
}

function collectModalValues(data: DiscordInteractionData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const row of data.components ?? []) {
    for (const comp of row.components ?? []) {
      if (typeof comp.custom_id === "string") {
        out[comp.custom_id] = comp.value ?? ""
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Public parser
// ---------------------------------------------------------------------------

export interface ParseDiscordDispatchOptions {
  /**
   * Keep the bot's own messages instead of dropping them. Used by the
   * `fetchHistory` projection, where the bot's past sends are legitimate
   * history entries. Live gateway dispatches must NOT set this — the
   * gateway echoes every bot send back as MESSAGE_CREATE, and forwarding
   * that echo makes the AI loop reply to itself (self-echo loop under the
   * `always` at-strategy / DM default).
   */
  allowSelfEcho?: boolean
}

/**
 * Parse a Discord Gateway dispatch into a NormalizedInboundEvent.
 *
 * Returns `null` for dispatches that flow through other channels:
 *   - INTERACTION_CREATE goes through `parseDiscordInteraction`.
 *   - The bot's own MESSAGE_CREATE / MESSAGE_UPDATE echoes (self-echo
 *     guard; disabled via `parseOpts.allowSelfEcho` for history).
 *   - Unknown / unsubscribed dispatches.
 */
export function parseDiscordDispatch(
  adapterId: string,
  selfId: string,
  dispatch: DiscordDispatch,
  parseOpts?: ParseDiscordDispatchOptions
): NormalizedInboundEvent | null {
  switch (dispatch.t) {
    case "MESSAGE_CREATE":
    case "MESSAGE_UPDATE": {
      const msg = dispatch.d as DiscordMessage
      // Self-echo guard: drop only the bot's OWN messages (selfId may be ""
      // before READY — never treat that as a match). Do NOT drop all
      // `author.bot` messages: other bots' traffic is legitimate inbound
      // (the sibling anti-loop gate handles cross-adapter loops).
      if (!parseOpts?.allowSelfEcho && selfId && msg.author?.id === selfId) {
        return null
      }
      return messageToEvent(
        adapterId,
        selfId,
        msg,
        dispatch,
        dispatch.t === "MESSAGE_UPDATE" ? "edit" : undefined
      )
    }
    case "MESSAGE_DELETE":
      return deleteToEvent(adapterId, selfId, dispatch.d as DiscordMessageDeletePayload, dispatch)
    case "MESSAGE_REACTION_ADD":
      return reactionToEvent(
        adapterId,
        selfId,
        dispatch.d as DiscordReactionDispatch,
        dispatch,
        true
      )
    case "MESSAGE_REACTION_REMOVE":
      return reactionToEvent(
        adapterId,
        selfId,
        dispatch.d as DiscordReactionDispatch,
        dispatch,
        false
      )
    default:
      return null
  }
}
