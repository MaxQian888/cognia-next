/**
 * Telegram update → NormalizedInboundEvent parser.
 *
 * Handles the update types Phase 1 + G3.1 surface:
 * - `message`              → kind="create" with text + media segments.
 * - `channel_post`         → kind="create" (anonymous channel post).
 * - `edited_message`       → kind="edit" with `replacesMessageId` set so the bus
 *                            can update the existing StoredMessage in place.
 * - `message_reaction`     → kind="system" with systemKind="reaction_added"/"reaction_removed".
 * - `callback_query`       → routed through `parseTelegramCallbackQuery` to the
 *                            ConnectorBus callback channel (NOT messageToEvent).
 *
 * Native media coverage (G3.1):
 *   text, photo, voice, audio, video, video_note, document, animation,
 *   sticker, location, contact, dice. Each maps to the closest
 *   MessageSegment kind; non-mapped fields degrade to a plain-text
 *   description so the assistant sees SOMETHING.
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"
import { MentionAccumulator } from "@/lib/connectors/adapters/_shared/mention-extractor"
import type { ConnectorCallbackEvent } from "@/types/connectors/interaction"

// ---------------------------------------------------------------------------
// Minimal Telegram Bot API types (only the fields we consume)
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: "private" | "group" | "supergroup" | "channel"
  title?: string
  username?: string
  first_name?: string
  last_name?: string
  is_forum?: boolean
}

export interface TelegramMessageEntity {
  type: string
  offset: number
  length: number
  user?: TelegramUser
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  file_size?: number
  width: number
  height: number
}

export interface TelegramVoice {
  file_id: string
  duration: number
  mime_type?: string
  file_size?: number
}

export interface TelegramAudio {
  file_id: string
  duration: number
  title?: string
  performer?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramVideo {
  file_id: string
  width: number
  height: number
  duration: number
  mime_type?: string
  file_size?: number
  thumb?: TelegramPhotoSize
}

export interface TelegramVideoNote {
  file_id: string
  length: number
  duration: number
  thumb?: TelegramPhotoSize
}

export interface TelegramDocument {
  file_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramAnimation {
  file_id: string
  width: number
  height: number
  duration: number
  thumb?: TelegramPhotoSize
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramSticker {
  file_id: string
  emoji?: string
  set_name?: string
  is_animated?: boolean
  is_video?: boolean
  width: number
  height: number
}

export interface TelegramLocation {
  longitude: number
  latitude: number
  /** Optional live-location accuracy. */
  horizontal_accuracy?: number
}

export interface TelegramContact {
  phone_number: string
  first_name: string
  last_name?: string
  user_id?: number
}

export interface TelegramDice {
  emoji: string
  value: number
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  message_thread_id?: number
  text?: string
  caption?: string
  entities?: TelegramMessageEntity[]
  caption_entities?: TelegramMessageEntity[]
  photo?: TelegramPhotoSize[]
  voice?: TelegramVoice
  audio?: TelegramAudio
  video?: TelegramVideo
  video_note?: TelegramVideoNote
  document?: TelegramDocument
  animation?: TelegramAnimation
  sticker?: TelegramSticker
  location?: TelegramLocation
  contact?: TelegramContact
  dice?: TelegramDice
  reply_to_message?: TelegramMessage
  /**
   * Present on every part of an album. Telegram has no multi-media message on
   * the wire: N updates share this id and the caption rides on exactly one of
   * them. `lib/connectors/adapters/telegram/album.ts` reassembles them.
   */
  media_group_id?: string
  /** Set on edited_message updates — Telegram's wall-clock for the edit. */
  edit_date?: number
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
  /** Inline-keyboard data passthrough; rare. Not used by parse logic. */
  game_short_name?: string
  inline_message_id?: string
}

export interface TelegramReactionType {
  /** `emoji` for standard reactions, `custom_emoji` for premium ones. */
  type: "emoji" | "custom_emoji"
  emoji?: string
  custom_emoji_id?: string
}

export interface TelegramMessageReactionUpdated {
  chat: TelegramChat
  message_id: number
  user?: TelegramUser
  /** Set instead of `user` for anonymous group admins / channel reactions. */
  actor_chat?: TelegramChat
  date: number
  old_reaction: TelegramReactionType[]
  new_reaction: TelegramReactionType[]
}

// GAP: my_chat_member handling (bot added/removed/permission changes) is not
// implemented — follow-up. Album aggregation now lives in `./album.ts`.
export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  edited_channel_post?: TelegramMessage
  callback_query?: TelegramCallbackQuery
  message_reaction?: TelegramMessageReactionUpdated
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSenderId(chatId: number, userId: number): string {
  return `tg:${chatId}:${userId}`
}

function buildPlatformIdentity(
  adapterId: string,
  chatId: number,
  user: TelegramUser
): PlatformIdentity {
  return {
    id: buildSenderId(chatId, user.id),
    platform: "telegram",
    adapterId,
    remoteUserId: String(user.id),
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username,
    avatarUrl: undefined,
  }
}

/**
 * Detect if the bot is mentioned via entities, reply_to, or text_mention.
 * Uses the shared `MentionAccumulator` so dedup + self-detection stays
 * consistent across all five platforms.
 */
function detectMentions(
  selfId: string,
  msg: TelegramMessage
): { selfMentioned: boolean; users: string[] } {
  const acc = new MentionAccumulator(selfId)

  // Reply to the bot's own message counts as a self-mention.
  if (msg.reply_to_message?.from?.id !== undefined) {
    const replieeId = String(msg.reply_to_message.from.id)
    if (replieeId === selfId) acc.markSelfMentioned()
  }

  // Walk both message and caption entity lists — captions on media
  // messages carry @mentions in the same shape.
  const allEntities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])]
  const textSource = msg.text ?? msg.caption ?? ""
  for (const entity of allEntities) {
    if (entity.type === "mention") {
      const mentioned = textSource.slice(entity.offset, entity.offset + entity.length).trim()
      acc.add(mentioned)
    } else if (entity.type === "text_mention" && entity.user) {
      acc.add(String(entity.user.id))
    }
  }

  return acc.finalize()
}

function buildSegments(msg: TelegramMessage): MessageSegment[] {
  const segments: MessageSegment[] = []
  const captionAfter = (): void => {
    if (msg.caption) segments.push({ type: "text", text: msg.caption })
  }

  // Photo message. PhotoSize[] is ordered small→large, so when Telegram
  // omits file_size the LAST entry is the largest — the old reduce defaulted
  // to the first (smallest) rendition in that case (audited fix #10).
  if (msg.photo && msg.photo.length > 0) {
    const withSize = msg.photo.filter((p) => p.file_size !== undefined)
    const largest =
      withSize.length > 0
        ? withSize.reduce((best, p) => (p.file_size! > best.file_size! ? p : best))
        : msg.photo[msg.photo.length - 1]
    segments.push({
      type: "image",
      url: `tg://file/${largest.file_id}`,
      width: largest.width,
      height: largest.height,
    })
    captionAfter()
    return segments
  }

  // Voice (always a voice segment — transcript is generated server-side later)
  if (msg.voice) {
    segments.push({
      type: "voice",
      url: `tg://file/${msg.voice.file_id}`,
      durationSec: msg.voice.duration,
    })
    captionAfter()
    return segments
  }

  // Audio file (music / podcast). Treat as a generic file with a friendly name.
  if (msg.audio) {
    const name = msg.audio.title ?? msg.audio.performer ?? `audio-${msg.audio.file_id.slice(0, 8)}`
    segments.push({
      type: "file",
      url: `tg://file/${msg.audio.file_id}`,
      name,
      mimeType: msg.audio.mime_type ?? "audio/mpeg",
      sizeBytes: msg.audio.file_size ?? 0,
    })
    captionAfter()
    return segments
  }

  // Video / video_note / animation — all surface as `video` segments so
  // downstream renderers treat them identically. video_note (round avatar
  // recording) carries a `length` field instead of width/height.
  const videoLike = msg.video ?? msg.video_note ?? msg.animation
  if (videoLike) {
    segments.push({
      type: "video",
      url: `tg://file/${videoLike.file_id}`,
      thumbnailUrl:
        "thumb" in videoLike && videoLike.thumb
          ? `tg://file/${videoLike.thumb.file_id}`
          : undefined,
      durationSec: videoLike.duration,
    })
    captionAfter()
    return segments
  }

  // Document — generic file. Use the original file name where Telegram
  // provided one, else synthesise from the file_id.
  if (msg.document) {
    segments.push({
      type: "file",
      url: `tg://file/${msg.document.file_id}`,
      name: msg.document.file_name ?? `document-${msg.document.file_id.slice(0, 8)}`,
      mimeType: msg.document.mime_type ?? "application/octet-stream",
      sizeBytes: msg.document.file_size ?? 0,
    })
    captionAfter()
    return segments
  }

  // Sticker — surface the sticker emoji as an emoji segment so trigger
  // matchers and the renderer treat the message like an emoji.
  if (msg.sticker) {
    segments.push({ type: "emoji", code: msg.sticker.emoji ?? "sticker" })
    return segments
  }

  // Location — proper location segment.
  if (msg.location) {
    segments.push({
      type: "location",
      lat: msg.location.latitude,
      lon: msg.location.longitude,
    })
    return segments
  }

  // Contact — fall back to a friendly text rendering (no canonical
  // segment kind for contact cards).
  if (msg.contact) {
    const name = [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(" ")
    segments.push({
      type: "text",
      text: `[contact] ${name} ${msg.contact.phone_number}`,
    })
    return segments
  }

  // Dice — Telegram's animated dice / dart / basketball / bowling /
  // soccer / slot machine. Surface the emoji + outcome value.
  if (msg.dice) {
    segments.push({ type: "text", text: `${msg.dice.emoji} (${msg.dice.value})` })
    return segments
  }

  // Plain text or caption-only message
  if (msg.text) {
    segments.push({ type: "text", text: msg.text })
  } else if (msg.caption) {
    segments.push({ type: "text", text: msg.caption })
  }

  return segments
}

/**
 * Project a Telegram message into a NormalizedInboundEvent. Shared by the
 * regular-message, channel-post, and edited-message paths so all three carry
 * identical sender / channel / mention metadata. The caller decides the
 * `kind` and (for edits) sets `replacesMessageId`.
 */
function messageToEvent(
  adapterId: string,
  selfId: string,
  msg: TelegramMessage,
  rawUpdate: TelegramUpdate,
  kindOverride?: "create" | "edit",
  replacesMessageId?: string
): NormalizedInboundEvent {
  const from = msg.from
  const chat = msg.chat
  const chatId = chat.id
  const userId = from?.id ?? chatId // fallback to chatId for channel posts

  const threadId = msg.message_thread_id !== undefined ? String(msg.message_thread_id) : undefined

  const conversationKey = buildConversationKey("telegram", adapterId, String(chatId), threadId)

  const sender = buildPlatformIdentity(adapterId, chatId, {
    id: userId,
    first_name: from?.first_name ?? chat.first_name,
    last_name: from?.last_name ?? chat.last_name,
    username: from?.username ?? chat.username,
  })

  const { selfMentioned, users } = detectMentions(selfId, msg)

  const segments = buildSegments(msg)
  const plainText = segmentsToPlainText(segments)

  const replyTo =
    msg.reply_to_message !== undefined
      ? {
          messageId: String(msg.reply_to_message.message_id),
          snippet: (msg.reply_to_message.text ?? msg.reply_to_message.caption ?? "").slice(0, 100),
          // Telegram carries the parent author inline — lets the exact
          // `reply-to-bot` rule match without a ledger lookup.
          ...(msg.reply_to_message.from?.id !== undefined
            ? { parentSenderId: String(msg.reply_to_message.from.id) }
            : {}),
        }
      : undefined

  const channelKind: "private" | "group" | "channel" | "thread" =
    chat.type === "private"
      ? "private"
      : chat.type === "channel"
        ? "channel"
        : threadId !== undefined
          ? "thread"
          : "group"

  // Use edit_date when present so dedup on edited messages picks the
  // wall-clock the edit happened, not the original send time.
  const timestamp = (msg.edit_date ?? msg.date) * 1000

  return {
    platform: "telegram",
    adapterId,
    selfId,
    messageId: String(msg.message_id),
    conversationRef: {
      platform: "telegram",
      adapterId,
      chatId: String(chatId),
      messageId: String(msg.message_id),
    },
    conversationKey,
    sender,
    channel: {
      id: conversationKey,
      name: chat.title ?? chat.username ?? chat.first_name,
      kind: channelKind,
      platformChannelId: String(chatId),
    },
    segments,
    plainText,
    replyTo,
    mentions: { selfMentioned, users },
    timestamp,
    raw: rawUpdate,
    kind: kindOverride ?? "create",
    replacesMessageId,
  }
}

/**
 * Project a `message_reaction` update into a system event. The bus walks
 * the `old_reaction` / `new_reaction` arrays and emits one `reaction_added`
 * or `reaction_removed` per delta — but the runtime currently consumes
 * `system` events at the audit-only layer, so for parity with Discord /
 * Lark we emit a single representative event tagged with the dominant
 * change (added wins over removed when both are present).
 */
function reactionToEvent(
  adapterId: string,
  selfId: string,
  reactionUpd: TelegramMessageReactionUpdated,
  rawUpdate: TelegramUpdate
): NormalizedInboundEvent | null {
  // Anonymous group admins / channel reactions arrive with `actor_chat`
  // set instead of `user` — fall back to the chat as the actor rather
  // than dropping the event (audited fix #11).
  const actorChat = reactionUpd.actor_chat
  if (!reactionUpd.user && !actorChat) return null

  const added = reactionUpd.new_reaction.filter(
    (r) => !reactionUpd.old_reaction.some((o) => sameReaction(o, r))
  )
  const removed = reactionUpd.old_reaction.filter(
    (r) => !reactionUpd.new_reaction.some((o) => sameReaction(o, r))
  )
  const isAdd = added.length > 0
  const representative = (isAdd ? added : removed)[0]
  if (!representative) return null

  const chat = reactionUpd.chat
  const chatId = chat.id
  const conversationKey = buildConversationKey("telegram", adapterId, String(chatId))
  const actorId = reactionUpd.user?.id ?? actorChat!.id
  const sender = reactionUpd.user
    ? buildPlatformIdentity(adapterId, chatId, reactionUpd.user)
    : buildPlatformIdentity(adapterId, chatId, {
        id: actorChat!.id,
        first_name: actorChat!.title ?? actorChat!.first_name,
        last_name: actorChat!.last_name,
        username: actorChat!.username,
      })

  return {
    platform: "telegram",
    adapterId,
    selfId,
    messageId: `tgreact:${reactionUpd.message_id}:${actorId}:${reactionUpd.date}`,
    conversationRef: {
      platform: "telegram",
      adapterId,
      chatId: String(chatId),
      messageId: String(reactionUpd.message_id),
    },
    conversationKey,
    sender,
    channel: {
      id: conversationKey,
      name: chat.title ?? chat.username ?? chat.first_name,
      kind: chat.type === "private" ? "private" : chat.type === "channel" ? "channel" : "group",
      platformChannelId: String(chatId),
    },
    segments: [
      {
        type: "emoji",
        code:
          representative.type === "emoji"
            ? (representative.emoji ?? "?")
            : `custom:${representative.custom_emoji_id ?? "?"}`,
      },
    ],
    plainText: representative.emoji ?? "[reaction]",
    mentions: { selfMentioned: false, users: [] },
    timestamp: reactionUpd.date * 1000,
    raw: rawUpdate,
    kind: "system",
    systemKind: isAdd ? "reaction_added" : "reaction_removed",
    replacesMessageId: String(reactionUpd.message_id),
  }
}

function sameReaction(a: TelegramReactionType, b: TelegramReactionType): boolean {
  if (a.type !== b.type) return false
  if (a.type === "emoji") return a.emoji === b.emoji
  return a.custom_emoji_id === b.custom_emoji_id
}

// ---------------------------------------------------------------------------
// Callback-query → ConnectorCallbackEvent (G4 channel)
// ---------------------------------------------------------------------------

/**
 * Project a Telegram callback_query into a `ConnectorCallbackEvent`
 * suitable for `ConnectorBus.dispatchConnectorCallback`.
 *
 * Telegram inline-keyboard buttons carry up to 64 bytes of `callback_data`.
 * The Telegram A2UI mapper (`a2ui-mapper.ts`) writes the long
 * `a2ui:<surfaceId>:<componentId>:<action>` id into
 * `connectorCallbackBindings` and uses a SHA-1-suffix short form on the
 * wire when needed. The bus's `dispatchConnectorCallback` recovers the
 * surface context via the binding lookup — adapter side just hands back
 * whatever data string Telegram delivered.
 *
 * Returns `null` for inline-message-only callbacks (no anchoring chat)
 * because we don't subscribe to bot-management surfaces.
 */
export function parseTelegramCallbackQuery(
  adapterId: string,
  selfId: string,
  update: TelegramUpdate
): ConnectorCallbackEvent | null {
  const cq = update.callback_query
  if (!cq?.message) return null

  const msg = cq.message
  const chatId = msg.chat.id
  const threadId = msg.message_thread_id !== undefined ? String(msg.message_thread_id) : undefined
  const conversationKey = buildConversationKey("telegram", adapterId, String(chatId), threadId)
  const sender = buildPlatformIdentity(adapterId, chatId, cq.from)

  const value = cq.data ?? ""

  return {
    platform: "telegram",
    adapterId,
    selfId,
    // The callback_query.id is globally unique per press — Telegram never
    // re-issues it. Perfect dedup key for namespace="callback".
    triggerId: value || `tgcq:${cq.id}`,
    // surfaceId / componentId are resolved via the binding row written at
    // outbound time. The event passes whatever we have right now (empty)
    // and the bus's `resolveCallbackBinding` upgrades them.
    surfaceId: "",
    componentId: undefined,
    actionType: "button",
    value,
    payload: undefined,
    originatingMessageId: String(msg.message_id),
    conversationKey,
    user: sender,
    timestamp: Date.now(),
    raw: update,
  }
}

/**
 * Correlate an inbound message against an outstanding ForceReply binding
 * (ADR-0009 v41 / B2). If the message has a `reply_to_message.message_id`
 * that matches a `kind: "force_reply"` row in `connectorCallbackBindings`
 * for this adapter, synthesise a `ConnectorCallbackEvent{actionType:"input"}`
 * so the bus routes the user's free-text reply onto the A2UI surface as
 * if they had typed into a native TextField/TextArea.
 *
 * Returns `null` when there's no `reply_to_message`, no matching binding,
 * or the binding has expired. The transport then falls back to the
 * normal `parseTelegramUpdate` message path.
 */
export async function parseTelegramForceReplyCorrelation(
  adapterId: string,
  selfId: string,
  update: TelegramUpdate
): Promise<ConnectorCallbackEvent | null> {
  const msg = update.message ?? update.channel_post
  if (!msg?.reply_to_message?.message_id) return null

  // Lazy import to avoid a circular dep through the bus barrel.
  const { resolveCallbackBinding } = await import("@/lib/connectors/adapters/_shared/a2ui-mapper")
  const binding = await resolveCallbackBinding(adapterId, String(msg.reply_to_message.message_id))
  if (!binding || binding.kind !== "force_reply") return null
  if (binding.expiresAt !== undefined && binding.expiresAt < Date.now()) return null

  const chatId = msg.chat.id
  const threadId = msg.message_thread_id !== undefined ? String(msg.message_thread_id) : undefined
  const conversationKey = buildConversationKey("telegram", adapterId, String(chatId), threadId)
  const userInfo = msg.from
  const sender = userInfo
    ? buildPlatformIdentity(adapterId, chatId, userInfo)
    : {
        id: `telegram:${adapterId}:${chatId}`,
        platform: "telegram" as const,
        adapterId,
        remoteUserId: String(chatId),
      }

  const text = msg.text ?? msg.caption ?? ""

  return {
    platform: "telegram",
    adapterId,
    selfId,
    triggerId: `tgfr:${msg.message_id}:${msg.reply_to_message.message_id}`,
    surfaceId: binding.surfaceId,
    componentId: binding.componentId,
    actionType: "input",
    value: text,
    payload: undefined,
    originatingMessageId: String(msg.message_id),
    conversationKey: binding.conversationKey ?? conversationKey,
    user: sender,
    timestamp: Date.now(),
    raw: update,
  }
}

// ---------------------------------------------------------------------------
// Public parser
// ---------------------------------------------------------------------------

/**
 * Parse a Telegram update envelope into a `NormalizedInboundEvent`.
 *
 * Returns `null` for updates we deliberately ignore:
 * - callback_query (use `parseTelegramCallbackQuery` instead — the
 *   transport routes those through `ConnectorBus.dispatchConnectorCallback`).
 * - inline-message-only callback_query (no anchoring chat).
 * - empty / unrecognised update types.
 */
/**
 * The album this update belongs to, or `undefined`.
 *
 * Only a NEW message can be an album part: an edit addresses one specific part
 * of an already-delivered album, so re-buffering it would hold an edit for the
 * album window and then merge it into a group it does not belong to.
 */
export function albumGroupIdOf(update: TelegramUpdate): string | undefined {
  const msg = update.message ?? update.channel_post
  return msg?.media_group_id
}

export function parseTelegramUpdate(
  adapterId: string,
  selfId: string,
  update: TelegramUpdate
): NormalizedInboundEvent | null {
  // ── Edits (regular chat or channel post) → kind=edit ──────────────────
  if (update.edited_message !== undefined) {
    return messageToEvent(
      adapterId,
      selfId,
      update.edited_message,
      update,
      "edit",
      String(update.edited_message.message_id)
    )
  }
  if (update.edited_channel_post !== undefined) {
    return messageToEvent(
      adapterId,
      selfId,
      update.edited_channel_post,
      update,
      "edit",
      String(update.edited_channel_post.message_id)
    )
  }

  // ── Reaction updates → system event ───────────────────────────────────
  if (update.message_reaction !== undefined) {
    return reactionToEvent(adapterId, selfId, update.message_reaction, update)
  }

  // ── Inline button press: handled separately via the callback channel ──
  if (update.callback_query !== undefined) {
    return null
  }

  // ── Regular create paths ──────────────────────────────────────────────
  const msg = update.message ?? update.channel_post
  if (!msg) return null
  return messageToEvent(adapterId, selfId, msg, update)
}
