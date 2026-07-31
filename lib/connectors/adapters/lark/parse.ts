/**
 * Lark event-subscription envelope → NormalizedInboundEvent parser.
 *
 * Handles (schema 2.0):
 *   - im.message.receive_v1            → kind="create"
 *   - im.message.message_read_v1        → kind="system" / read_indicator
 *   - im.message.recalled_v1            → kind="delete" with replacesMessageId
 *   - im.chat.member.bot.added_v1       → kind="system" / member_added (bot)
 *   - im.chat.member.bot.deleted_v1     → kind="system" / member_removed (bot)
 *   - im.chat.member.user.added_v1      → kind="system" / member_added
 *   - im.chat.member.user.deleted_v1    → kind="system" / member_removed
 *   - im.message.reaction.created_v1    → kind="system" / reaction_added
 *   - im.message.reaction.deleted_v1    → kind="system" / reaction_removed
 *
 * `im.message.receive_v1` carries the only payload that produces a
 * StoredMessage downstream; the system events feed the audit log.
 *
 * Returns null for any other event type.
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
import { resolveQuickCommand, type LarkQuickCommand } from "./quick-commands"

// ---------------------------------------------------------------------------
// Lark event envelope types
// ---------------------------------------------------------------------------

export interface LarkMentionId {
  open_id?: string
  user_id?: string
}

export interface LarkMention {
  key: string
  /**
   * Live `im.message.receive_v1` events nest the identity
   * (`{ open_id, user_id }`); the `/im/v1/messages` history list flattens
   * it to a plain string discriminated by `id_type`. Both shapes reach this
   * parser because `fetchHistory` reprojects raw list items through it.
   */
  id: LarkMentionId | string
  /** History-list shape only: "open_id" | "union_id" | "user_id". */
  id_type?: string
  name?: string
}

export interface LarkSenderId {
  open_id?: string
  user_id?: string
}

export interface LarkSender {
  /** Live-event shape (`im.message.receive_v1` push): nested ids. */
  sender_id: LarkSenderId
  sender_type?: string
  tenant_key?: string
  /**
   * History shape (`GET /im/v1/messages` items, wrapped into synthetic
   * envelopes by `fetchHistory`): a flat `id` + `id_type` pair instead of
   * the nested `sender_id`. `id_type` is `open_id` for human senders and
   * `app_id` for bot/app senders (including our own bot's past messages).
   */
  id?: string
  id_type?: string
}

export interface LarkMessage {
  message_id: string
  chat_id: string
  chat_type: "p2p" | "group"
  message_type: string
  content: string
  mentions?: LarkMention[]
  create_time?: string
  thread_id?: string | null
}

export interface LarkEventHeader {
  event_id: string
  event_type: string
  create_time?: string
  token?: string
  app_id?: string
  /**
   * Sender's tenant. Present on every 2.0 envelope header; in an external
   * (cross-tenant) group this identifies which tenant the message came from.
   */
  tenant_key?: string
}

export interface LarkEventBody {
  // im.message.receive_v1
  sender?: LarkSender
  message?: LarkMessage
  // im.message.message_read_v1
  reader?: { reader_id?: LarkSenderId; read_time?: string; tenant_key?: string }
  message_id_list?: string[]
  // im.message.recalled_v1
  message_id?: string
  chat_id?: string
  recall_time?: string
  recall_type?: string
  // im.chat.member.* — both user + bot variants share these fields
  chat_id_list?: never
  operator_id?: LarkSenderId
  external?: boolean
  users?: Array<{ user_id?: LarkSenderId; name?: string }>
  // im.message.reaction.{created,deleted}_v1
  reaction_type?: { emoji_type?: string }
  operator_type?: string
  user_id?: LarkSenderId
  app_id?: string
  action_time?: string
}

export interface LarkEventEnvelope {
  schema?: string
  header: LarkEventHeader
  event: LarkEventBody
}

/**
 * Pull the sender's `tenant_key` out of an inbound envelope. The 2.0 header
 * carries it on every event; older/edge payloads only nest it under the
 * sender (message events) or reader (read indicators), so fall back to those.
 * Returns undefined when absent (e.g. synthetic history envelopes).
 *
 * Used to backfill `lastWhoamiResult.tenantKey` — the `/bot/v3/info` whoami
 * probe cannot return it, so the first real inbound event supplies it. This
 * is the only signal that identifies the tenant behind a cross-tenant
 * (external-group) sender.
 */
export function extractTenantKey(envelope: LarkEventEnvelope): string | undefined {
  return (
    envelope.header?.tenant_key ||
    envelope.event?.sender?.tenant_key ||
    envelope.event?.reader?.tenant_key ||
    undefined
  )
}

/**
 * Tenancy scope of a verified envelope, stamped onto produced events as
 * `channelData.identityScope` (inbound) / `identityScope` (callbacks) so the
 * principal registry can resolve `tenantKey + appId + openId` without
 * re-touching raw payloads (plan 2026-07-24 Phase 1).
 */
export function identityScopeOf(
  envelope: LarkEventEnvelope
): { tenantKey?: string; appId?: string } | undefined {
  const tenantKey = extractTenantKey(envelope)
  const appId = envelope.header?.app_id
  if (!tenantKey && !appId) return undefined
  return { tenantKey, appId }
}

// ---------------------------------------------------------------------------
// Parser helpers
// ---------------------------------------------------------------------------

function buildPlatformIdentity(adapterId: string, openId: string): PlatformIdentity {
  return {
    id: `lark:${openId}`,
    platform: "lark",
    adapterId,
    remoteUserId: openId,
    displayName: undefined,
    avatarUrl: undefined,
  }
}

/**
 * Extract the open_id from either mention shape. Flat (history-list) ids
 * only count when typed as open_id — a union_id/user_id cannot be compared
 * against the bot's open_id, so it is dropped rather than misclassified.
 */
function mentionOpenId(mention: LarkMention): string | undefined {
  if (typeof mention.id === "string") {
    return mention.id_type === undefined || mention.id_type === "open_id" ? mention.id : undefined
  }
  return mention.id?.open_id
}

function detectMentions(
  selfBotOpenId: string,
  message: LarkMessage
): { selfMentioned: boolean; users: string[] } {
  const acc = new MentionAccumulator(selfBotOpenId)
  for (const mention of message.mentions ?? []) {
    acc.add(mentionOpenId(mention))
  }
  return acc.finalize()
}

/** A single node inside a Lark `post` (rich text) paragraph. */
interface LarkPostNode {
  tag?: string
  text?: string
  href?: string
  user_id?: string
  user_name?: string
  image_key?: string
  emoji_type?: string
}

/**
 * Flatten a Lark `post` (rich text) payload into a plain-text string plus any
 * embedded image keys. Handles both the already-unwrapped `{title, content}`
 * shape and the locale-keyed `{zh_cn:{…}, en_us:{…}}` shape (the locale wrapper
 * Feishu sends on inbound). Unknown node tags contribute their `text` when
 * present so nothing is silently dropped.
 */
function parseLarkPost(parsed: Record<string, unknown>): { text: string; imageKeys: string[] } {
  let block = parsed as { title?: unknown; content?: unknown }
  if (!Array.isArray(block.content)) {
    for (const key of Object.keys(parsed)) {
      const v = parsed[key] as { content?: unknown } | undefined
      if (v && typeof v === "object" && Array.isArray(v.content)) {
        block = v as { title?: unknown; content?: unknown }
        break
      }
    }
  }

  const title = typeof block.title === "string" ? block.title : ""
  const paragraphs = Array.isArray(block.content) ? (block.content as LarkPostNode[][]) : []
  const imageKeys: string[] = []
  const lines: string[] = []
  if (title) lines.push(title)

  for (const para of paragraphs) {
    if (!Array.isArray(para)) continue
    let line = ""
    for (const node of para) {
      switch (node?.tag) {
        case "text":
          line += node.text ?? ""
          break
        case "a":
          line += node.href ? `${node.text ?? node.href} (${node.href})` : (node.text ?? "")
          break
        case "at":
          line += `@${node.user_name ?? node.user_id ?? ""}`
          break
        case "emotion":
          line += node.emoji_type ? `[${node.emoji_type}]` : ""
          break
        case "img":
          if (node.image_key) imageKeys.push(node.image_key)
          break
        default:
          if (typeof node?.text === "string") line += node.text
      }
    }
    lines.push(line)
  }

  return { text: lines.join("\n").trim(), imageKeys }
}

/** Best-effort MIME guess from a file name so the segment carries a type hint. */
function guessMimeFromName(name: string): string {
  const dot = name.lastIndexOf(".")
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
  switch (ext) {
    case "pdf":
      return "application/pdf"
    case "doc":
      return "application/msword"
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    case "xls":
      return "application/vnd.ms-excel"
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    case "ppt":
      return "application/vnd.ms-powerpoint"
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    case "txt":
      return "text/plain"
    case "csv":
      return "text/csv"
    case "png":
      return "image/png"
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "gif":
      return "image/gif"
    case "zip":
      return "application/zip"
    default:
      return "application/octet-stream"
  }
}

/**
 * Project an inbound Lark message's content JSON into typed `MessageSegment[]`.
 *
 * Rich media (image / post / file / audio / media) carries only its platform
 * media *ref* here (image_key / file_key); `inbound-media.ts:enrichLarkInboundMedia`
 * is the async second pass that downloads the bytes and attaches
 * `dataBase64` / `ocrText`. Stickers keep a text marker (no useful bytes).
 */
function buildSegments(message: LarkMessage): MessageSegment[] {
  const segments: MessageSegment[] = []

  try {
    const parsed = JSON.parse(message.content) as Record<string, unknown>

    switch (message.message_type) {
      case "text": {
        let text = typeof parsed["text"] === "string" ? parsed["text"] : ""
        // Lark replaces each @-mention in the raw text with an opaque
        // placeholder key ("@_user_1", "@_user_2", …) and ships the display
        // names separately in `mentions[]`. Substitute them back so the
        // model / stored message reads "@Alice" instead of "@_user_1".
        for (const mention of message.mentions ?? []) {
          if (mention.key && mention.name) {
            text = text.split(mention.key).join(`@${mention.name}`)
          }
        }
        if (text) {
          segments.push({ type: "text", text })
        }
        break
      }

      case "image": {
        const imageKey = typeof parsed["image_key"] === "string" ? parsed["image_key"] : ""
        if (imageKey) {
          segments.push({ type: "image", url: imageKey, alt: "image" })
        }
        break
      }

      case "post": {
        const { text, imageKeys } = parseLarkPost(parsed)
        if (text) segments.push({ type: "markdown", md: text })
        for (const key of imageKeys) {
          segments.push({ type: "image", url: key, alt: "image" })
        }
        break
      }

      case "file": {
        const fileKey = typeof parsed["file_key"] === "string" ? parsed["file_key"] : ""
        const fileName = typeof parsed["file_name"] === "string" ? parsed["file_name"] : "file"
        if (fileKey) {
          segments.push({
            type: "file",
            url: fileKey,
            name: fileName,
            mimeType: guessMimeFromName(fileName),
            sizeBytes: 0,
          })
        }
        break
      }

      case "audio": {
        const fileKey = typeof parsed["file_key"] === "string" ? parsed["file_key"] : ""
        const duration = typeof parsed["duration"] === "number" ? parsed["duration"] : undefined
        if (fileKey) {
          segments.push({
            type: "voice",
            url: fileKey,
            ...(duration !== undefined ? { durationSec: Math.round(duration / 1000) } : {}),
          })
        }
        break
      }

      // Feishu sends video as `media` (file_key + cover image_key); accept the
      // legacy `video` label too.
      case "media":
      case "video": {
        const fileKey = typeof parsed["file_key"] === "string" ? parsed["file_key"] : ""
        const cover = typeof parsed["image_key"] === "string" ? parsed["image_key"] : undefined
        const duration = typeof parsed["duration"] === "number" ? parsed["duration"] : undefined
        if (fileKey) {
          segments.push({
            type: "video",
            url: fileKey,
            ...(cover ? { thumbnailUrl: cover } : {}),
            ...(duration !== undefined ? { durationSec: Math.round(duration / 1000) } : {}),
          })
        }
        break
      }

      case "sticker": {
        segments.push({ type: "text", text: "[sticker]" })
        break
      }

      // ── Marker segments for share/rich types with no segment mapping ──
      // These previously fell through to the default branch and produced an
      // event with EMPTY segments/plainText, which in a p2p chat could
      // trigger an AI turn on literally nothing. Each type keeps a compact
      // text marker built from whatever the content JSON carries.
      case "share_chat": {
        const label = str(parsed["chat_name"]) || str(parsed["chat_id"])
        segments.push({ type: "text", text: label ? `[shared chat: ${label}]` : "[shared chat]" })
        break
      }

      case "share_user": {
        const label = str(parsed["user_name"]) || str(parsed["user_id"])
        segments.push({ type: "text", text: label ? `[shared user: ${label}]` : "[shared user]" })
        break
      }

      case "location": {
        // Wire shape: {"name":"...","longitude":"...","latitude":"..."}
        // (numbers serialized as strings). Project into the typed location
        // segment so plainText renders "[location:<name>]".
        const lat = Number(str(parsed["latitude"]))
        const lon = Number(str(parsed["longitude"]))
        const name = str(parsed["name"])
        segments.push({
          type: "location",
          lat: Number.isFinite(lat) ? lat : 0,
          lon: Number.isFinite(lon) ? lon : 0,
          ...(name ? { name } : {}),
        })
        break
      }

      case "todo": {
        const label = str(parsed["summary"]) || str(parsed["task_id"])
        segments.push({ type: "text", text: label ? `[todo: ${label}]` : "[todo]" })
        break
      }

      case "calendar":
      case "share_calendar_event": {
        const label = str(parsed["summary"]) || str(parsed["title"])
        segments.push({
          type: "text",
          text: label ? `[calendar event: ${label}]` : "[calendar event]",
        })
        break
      }

      default:
        break
    }
  } catch {
    // Malformed content — return empty segments
  }

  return segments
}

/** Coerce an unknown JSON field to a trimmed string ("" when absent). */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/**
 * Build a system / audit-only stub event. The bus uses
 * `kind === "system"` to skip StoredMessage insertion and write a single
 * audit row matching `systemKind`. The downstream consumer doesn't see
 * any text — fields are minimal but typed.
 */
function buildSystemEvent(
  adapterId: string,
  selfBotOpenId: string,
  envelope: LarkEventEnvelope,
  systemKind: NonNullable<NormalizedInboundEvent["systemKind"]>,
  chatId: string,
  actorOpenId: string | undefined,
  syntheticMessageId: string,
  channelKind: "private" | "group" | "thread" = "group"
): NormalizedInboundEvent {
  return {
    platform: "lark",
    adapterId,
    selfId: selfBotOpenId,
    messageId: syntheticMessageId,
    conversationRef: {
      platform: "lark",
      adapterId,
      channelId: chatId,
    },
    conversationKey: buildConversationKey("lark", adapterId, chatId),
    sender: actorOpenId
      ? buildPlatformIdentity(adapterId, actorOpenId)
      : {
          id: `lark:unknown`,
          platform: "lark",
          adapterId,
          remoteUserId: "unknown",
        },
    channel: {
      id: buildConversationKey("lark", adapterId, chatId),
      kind: channelKind,
      platformChannelId: chatId,
    },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: envelope,
    kind: "system",
    systemKind,
  }
}

/**
 * Parse a Lark event-subscription envelope into a NormalizedInboundEvent.
 *
 * Returns null for unrecognised event types or malformed payloads.
 */
export function parseLarkEventEnvelope(
  adapterId: string,
  selfBotOpenId: string,
  envelope: LarkEventEnvelope
): NormalizedInboundEvent | null {
  const eventType = envelope.header?.event_type

  // ── Read indicator ───────────────────────────────────────────────────
  if (eventType === "im.message.message_read_v1") {
    const readerOpenId = envelope.event.reader?.reader_id?.open_id
    // Lark does not include chat_id on read events — fall back to the
    // first message id as a synthetic key so the audit row at least
    // ties back to one message. When neither is present we drop.
    const messageIds = envelope.event.message_id_list ?? []
    if (messageIds.length === 0) return null
    return buildSystemEvent(
      adapterId,
      selfBotOpenId,
      envelope,
      "read_indicator",
      messageIds[0],
      readerOpenId,
      `lark.read:${messageIds.join(",")}`
    )
  }

  // ── Recall (= delete) ────────────────────────────────────────────────
  if (eventType === "im.message.recalled_v1") {
    const messageId = envelope.event.message_id
    const chatId = envelope.event.chat_id
    if (!messageId || !chatId) return null
    return {
      platform: "lark",
      adapterId,
      selfId: selfBotOpenId,
      messageId,
      conversationRef: { platform: "lark", adapterId, channelId: chatId },
      conversationKey: buildConversationKey("lark", adapterId, chatId),
      sender: { id: `lark:unknown`, platform: "lark", adapterId, remoteUserId: "unknown" },
      channel: {
        id: buildConversationKey("lark", adapterId, chatId),
        kind: "group",
        platformChannelId: chatId,
      },
      segments: [],
      plainText: "",
      mentions: { selfMentioned: false, users: [] },
      timestamp: envelope.event.recall_time ? parseInt(envelope.event.recall_time, 10) : Date.now(),
      raw: envelope,
      kind: "delete",
      replacesMessageId: messageId,
    }
  }

  // ── Message reactions (emoji added / removed) ────────────────────────
  const reactionKinds: Record<string, "reaction_added" | "reaction_removed"> = {
    "im.message.reaction.created_v1": "reaction_added",
    "im.message.reaction.deleted_v1": "reaction_removed",
  }
  if (eventType && eventType in reactionKinds) {
    // The reaction payload carries no chat_id — anchor the audit row to
    // the reacted message id (same convention as read indicators above).
    const messageId = envelope.event.message_id
    if (!messageId) return null
    const operator = envelope.event.user_id?.open_id
    const emoji = envelope.event.reaction_type?.emoji_type ?? ""
    return buildSystemEvent(
      adapterId,
      selfBotOpenId,
      envelope,
      reactionKinds[eventType],
      messageId,
      operator,
      `lark.reaction:${eventType}:${emoji}:${envelope.header.event_id}`
    )
  }

  // ── Member changes (user + bot variants) ─────────────────────────────
  const memberAddRemove: Record<string, "member_added" | "member_removed"> = {
    "im.chat.member.bot.added_v1": "member_added",
    "im.chat.member.bot.deleted_v1": "member_removed",
    "im.chat.member.user.added_v1": "member_added",
    "im.chat.member.user.deleted_v1": "member_removed",
  }
  if (eventType && eventType in memberAddRemove) {
    const chatId = envelope.event.chat_id
    if (!chatId) return null
    const operator = envelope.event.operator_id?.open_id
    return buildSystemEvent(
      adapterId,
      selfBotOpenId,
      envelope,
      memberAddRemove[eventType],
      chatId,
      operator,
      `lark.member:${eventType}:${envelope.header.event_id}`
    )
  }

  // ── Regular message create ───────────────────────────────────────────
  if (eventType !== "im.message.receive_v1") return null

  const sender = envelope.event.sender
  const message = envelope.event.message
  if (!sender || !message) return null

  // Live push events nest the sender id (`sender_id.open_id`); history items
  // flatten it to `{id, id_type}` — `open_id` for humans, `app_id` for bots
  // (including this bot's own past messages). Accept both so `fetchHistory`
  // doesn't silently drop every message (proven live: the history API never
  // returns the nested shape).
  const openId =
    sender.sender_id?.open_id ??
    (typeof sender.id === "string" &&
    sender.id.length > 0 &&
    (sender.id_type === "open_id" || sender.id_type === "app_id")
      ? sender.id
      : undefined)
  if (!openId) return null

  // System notices ("A invited B", recall banners, …) carry no recoverable
  // content — dropping them here prevents an empty-plainText event from
  // triggering an AI turn in p2p chats. (`fetchHistory` already skips
  // msg_type=system before re-projection; this guards the live push path.)
  if (message.message_type === "system") return null

  const chatId = message.chat_id
  const threadId = message.thread_id ?? undefined

  const conversationKey = buildConversationKey("lark", adapterId, chatId, threadId)
  const senderIdentity = {
    ...buildPlatformIdentity(adapterId, openId),
    kind:
      sender.id_type === "app_id" || sender.sender_type === "app" || sender.sender_type === "bot"
        ? ("bot" as const)
        : ("human" as const),
  }
  const { selfMentioned, users } = detectMentions(selfBotOpenId, message)
  const segments = buildSegments(message)
  const plainText = segmentsToPlainText(segments)

  const channelKind: "private" | "group" | "thread" =
    threadId !== undefined ? "thread" : message.chat_type === "p2p" ? "private" : "group"

  const createTimeMs = message.create_time ? parseInt(message.create_time, 10) : Date.now()
  const identityScope = identityScopeOf(envelope)

  return {
    platform: "lark",
    adapterId,
    selfId: selfBotOpenId,
    messageId: message.message_id,
    conversationRef: {
      platform: "lark",
      adapterId,
      channelId: chatId,
      threadTs: threadId,
      // Reply anchor for thread sends: Lark's create-message endpoint has
      // no thread parameter, so `serialize.ts` must route thread sends
      // through POST /im/v1/messages/:id/reply — which needs an om_ message
      // id, not the thread_id. Any in-thread message is a valid anchor
      // (`reply_in_thread: true` lands the reply in that message's thread),
      // so carry the id of the message we just parsed.
      ...(threadId ? { threadRootMessageId: message.message_id } : {}),
    },
    conversationKey,
    conversationAddress: {
      conversationKey,
      platform: "lark",
      adapterId,
      scopeKind: channelKind,
      containerId: chatId,
      ...(threadId ? { topicId: threadId } : {}),
    },
    sender: senderIdentity,
    channel: {
      id: conversationKey,
      kind: channelKind,
      platformChannelId: chatId,
    },
    segments,
    plainText,
    replyTo: undefined,
    mentions: { selfMentioned, users },
    timestamp: createTimeMs,
    raw: envelope,
    ...(identityScope ? { channelData: { identityScope } } : {}),
  }
}

// ---------------------------------------------------------------------------
// Bot-menu (快捷指令) parser — application.bot.menu_v6
// ---------------------------------------------------------------------------

export interface LarkBotMenuEvent {
  operator?: { operator_id?: LarkSenderId }
  event_key?: string
  timestamp?: string
}

/**
 * Discriminated result of a bot-menu click (plan 2026-07-24 P4.2).
 *
 * `mapped` carries a synthetic `create` inbound event for the normal
 * gate → bus → ai-run pipeline; `link` and `unknown` are terminal at the
 * adapter (URL reply / fixed bilingual notice + audit) and MUST NOT reach
 * the model — an unmapped `event_key` used to fall back to a model prompt,
 * which let anyone with the menu drive arbitrary AI turns.
 */
export type LarkBotMenuOutcome =
  | {
      kind: "mapped"
      event: NormalizedInboundEvent
      /** Resolved from the reserved cognia.* built-ins, not an adapter row. */
      builtIn: boolean
      openId: string
      eventKey: string
      eventId: string
      identityScope?: { tenantKey?: string; appId?: string }
    }
  | {
      kind: "link"
      command: LarkQuickCommand
      builtIn: boolean
      openId: string
      eventKey: string
      eventId: string
      identityScope?: { tenantKey?: string; appId?: string }
    }
  | {
      kind: "unknown"
      openId: string
      eventKey: string
      eventId: string
      identityScope?: { tenantKey?: string; appId?: string }
    }

/**
 * Project an `application.bot.menu_v6` envelope (a bot-menu / 快捷指令 click)
 * into a `LarkBotMenuOutcome`.
 *
 * The menu event carries the operator's `open_id` but no `chat_id`, so
 * replies target the operator's p2p chat: `conversationRef.channelId` is set
 * to the `ou_…` open_id, which `serialize.ts:serializeOutboundAsync` resolves
 * to `receive_id_type=open_id`.
 *
 * Returns null for non-menu events or when operator / event_key are absent.
 */
export function parseLarkBotMenuEvent(
  adapterId: string,
  selfBotOpenId: string,
  envelope: LarkEventEnvelope,
  quickCommands: LarkQuickCommand[] | undefined
): LarkBotMenuOutcome | null {
  if (envelope.header?.event_type !== "application.bot.menu_v6") return null
  const event = envelope.event as unknown as LarkBotMenuEvent
  const openId = event.operator?.operator_id?.open_id
  const eventKey = event.event_key
  if (!openId || !eventKey) return null

  const eventId = envelope.header.event_id ?? ""
  const identityScope = identityScopeOf(envelope)
  // Adapter-configured rows first; the reserved cognia.* built-ins fill in
  // behind them. Which source matched is part of the outcome — the dispatch
  // site gates built-ins on the `larkNativeSlash` batch flag, while
  // configured rows are never gated (pre-epic behavior).
  const configured = quickCommands?.find((command) => command.triggerKey === eventKey)
  const mapped = configured ?? resolveQuickCommand(undefined, eventKey)
  const builtIn = !configured && mapped !== undefined
  if (!mapped) {
    return {
      kind: "unknown",
      openId,
      eventKey,
      eventId,
      ...(identityScope ? { identityScope } : {}),
    }
  }
  if (mapped.action.type === "link") {
    return {
      kind: "link",
      command: mapped,
      builtIn,
      openId,
      eventKey,
      eventId,
      ...(identityScope ? { identityScope } : {}),
    }
  }

  const text = mapped.action.value
  const conversationKey = buildConversationKey("lark", adapterId, openId)

  return {
    kind: "mapped",
    builtIn,
    openId,
    eventKey,
    eventId,
    ...(identityScope ? { identityScope } : {}),
    event: {
      platform: "lark",
      adapterId,
      selfId: selfBotOpenId,
      messageId: `lark.menu:${eventId}`,
      conversationRef: {
        platform: "lark",
        adapterId,
        channelId: openId,
      },
      conversationKey,
      sender: buildPlatformIdentity(adapterId, openId),
      channel: {
        id: conversationKey,
        kind: "private",
        platformChannelId: openId,
      },
      segments: [{ type: "text", text }],
      plainText: text,
      mentions: { selfMentioned: false, users: [] },
      timestamp: Date.now(),
      raw: envelope,
      kind: "create",
      ...(identityScope ? { channelData: { identityScope } } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Interactive card callback parser — G3.4
// ---------------------------------------------------------------------------

export interface LarkInteractiveValue {
  /** Baked by `buildLarkA2UICard`: long action_id string. */
  actionId?: string
  surfaceId?: string
  componentId?: string
  [k: string]: unknown
}

export interface LarkInteractiveAction {
  /** "button" | "select_static" | "picker_date" | "picker_time" | "input" | ... */
  tag?: string
  value?: LarkInteractiveValue
  /** select_static — the chosen option value. */
  option?: string
  /** picker_date — selected date in ISO 8601. */
  selected_date?: string
  /** picker_time — selected time HH:mm. */
  selected_time?: string
  /** input — submitted text. */
  input_value?: string
  /** select_static — display label of the chosen option. */
  text?: { content?: string }
  /** Card 2.0 form container submit — field name → submitted value. */
  form_value?: Record<string, unknown>
  /** Card 2.0 native checkbox / checker — checked state. */
  checked?: boolean
}

export interface LarkInteractiveEvent {
  operator?: LarkSenderId
  action?: LarkInteractiveAction
  open_message_id?: string
  open_chat_id?: string
  /** Card 2.0 (`card.action.trigger`) nests the message/chat ids here. */
  context?: { open_message_id?: string; open_chat_id?: string }
  tenant_key?: string
  /** Token Lark expects on the response when the bot updates the card. */
  token?: string
  /** Card-level callback id (rare). */
  callback_id?: string
}

/**
 * Project an interactive-card callback envelope into a
 * `ConnectorCallbackEvent` for the bus callback channel.
 *
 * Accepts both callback generations:
 *   - `im.interactive_message.action_triggered_v1` (legacy card callback)
 *   - `card.action.trigger` (Card 2.0 callback — nests the message/chat
 *     ids under `event.context` and adds `form_value` / `checked`)
 *
 * The `action.value.actionId` we baked at outbound time becomes the
 * `triggerId` so `ConnectorBus.dispatchConnectorCallback` resolves the
 * surface/component binding from `connectorCallbackBindings`.
 *
 * Returns null for unrecognised events or malformed envelopes.
 */
export function parseLarkInteractiveCallback(
  adapterId: string,
  selfBotOpenId: string,
  envelope: LarkEventEnvelope
): ConnectorCallbackEvent | null {
  const eventType = envelope.header?.event_type
  if (
    eventType !== "im.interactive_message.action_triggered_v1" &&
    eventType !== "card.action.trigger"
  ) {
    return null
  }
  const event = envelope.event as unknown as LarkInteractiveEvent
  const action = event.action
  if (!action) return null
  const operator = event.operator
  if (!operator?.open_id) return null
  const triggerId = action.value?.actionId ?? envelope.header.event_id
  if (!triggerId) return null

  let actionType: ConnectorCallbackActionType = "button"
  let value = ""
  let payload: Record<string, unknown> | undefined
  if (action.form_value && typeof action.form_value === "object") {
    // Card 2.0 form container submit — the whole form travels in one
    // callback; the bridge consumes it as `actionType: "submit"`.
    actionType = "submit"
    payload = action.form_value
  } else if (action.tag === "select_static") {
    actionType = "select"
    value = action.option ?? ""
    // B4 — simulated Checkbox (ADR-0009 v41). The mapper marks the wire
    // value with `simulatedCheckbox: true` so the parser can lift the
    // event back into a real `actionType: "checkbox"` event with a
    // canonical "true"/"false" value, sparing the bridge from a
    // platform-aware coercion step.
    if (
      typeof action.value === "object" &&
      action.value &&
      (action.value as Record<string, unknown>).simulatedCheckbox === true
    ) {
      actionType = "checkbox"
      value = value === "true" ? "true" : "false"
    }
  } else if (action.tag === "picker_date" || action.tag === "picker_time") {
    actionType = "input"
    value =
      action.tag === "picker_date" ? (action.selected_date ?? "") : (action.selected_time ?? "")
  } else if (action.tag === "input") {
    actionType = "input"
    value = action.input_value ?? ""
  } else if (action.tag === "checkbox" || typeof action.checked === "boolean") {
    // Legacy checkbox tag or a Card 2.0 native checker element.
    actionType = "checkbox"
    value = typeof action.checked === "boolean" ? String(action.checked) : (action.option ?? "")
  } else if (action.tag === "button") {
    actionType = "button"
    value =
      typeof action.value === "object" && action.value && "action" in action.value
        ? String((action.value as Record<string, unknown>).action ?? "")
        : ""
    payload = action.value
  }

  const chatId = event.open_chat_id ?? event.context?.open_chat_id
  const originatingMessageId = event.open_message_id ?? event.context?.open_message_id
  const conversationKey = chatId ? buildConversationKey("lark", adapterId, chatId) : undefined
  const user: PlatformIdentity = {
    id: `lark:${operator.open_id}`,
    platform: "lark",
    adapterId,
    remoteUserId: operator.open_id,
  }

  return {
    platform: "lark",
    adapterId,
    selfId: selfBotOpenId,
    triggerId,
    surfaceId: action.value?.surfaceId ?? "",
    componentId: action.value?.componentId,
    actionType,
    value,
    payload,
    originatingMessageId,
    conversationKey,
    user,
    // Card callbacks nest tenant_key on the event body rather than the
    // header on some generations — prefer the body, fall back to the header.
    identityScope:
      event.tenant_key || envelope.header?.tenant_key || envelope.header?.app_id
        ? {
            tenantKey: event.tenant_key ?? envelope.header?.tenant_key,
            appId: envelope.header?.app_id,
          }
        : undefined,
    timestamp: envelope.header.create_time ? parseInt(envelope.header.create_time, 10) : Date.now(),
    raw: envelope,
  }
}
