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
  id: LarkMentionId
  name?: string
}

export interface LarkSenderId {
  open_id?: string
  user_id?: string
}

export interface LarkSender {
  sender_id: LarkSenderId
  sender_type?: string
  tenant_key?: string
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
}

export interface LarkEventEnvelope {
  schema?: string
  header: LarkEventHeader
  event: LarkEventBody
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

function detectMentions(
  selfBotOpenId: string,
  message: LarkMessage
): { selfMentioned: boolean; users: string[] } {
  const acc = new MentionAccumulator(selfBotOpenId)
  for (const mention of message.mentions ?? []) {
    acc.add(mention.id?.open_id)
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
        const text = typeof parsed["text"] === "string" ? parsed["text"] : ""
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

      default:
        break
    }
  } catch {
    // Malformed content — return empty segments
  }

  return segments
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

  const openId = sender.sender_id?.open_id
  if (!openId) return null

  const chatId = message.chat_id
  const threadId = message.thread_id ?? undefined

  const conversationKey = buildConversationKey("lark", adapterId, chatId, threadId)
  const senderIdentity = buildPlatformIdentity(adapterId, openId)
  const { selfMentioned, users } = detectMentions(selfBotOpenId, message)
  const segments = buildSegments(message)
  const plainText = segmentsToPlainText(segments)

  const channelKind: "private" | "group" | "thread" =
    threadId !== undefined ? "thread" : message.chat_type === "p2p" ? "private" : "group"

  const createTimeMs = message.create_time ? parseInt(message.create_time, 10) : Date.now()

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
    },
    conversationKey,
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
 * Project an `application.bot.menu_v6` envelope (a bot-menu / 快捷指令 click)
 * into a synthetic `create` inbound event so it flows through the normal
 * gate → bus → ai-run pipeline.
 *
 * The menu event carries the operator's `open_id` but no `chat_id`, so the
 * reply targets the operator's p2p chat: `conversationRef.channelId` is set to
 * the `ou_…` open_id, which `serialize.ts:serializeOutboundAsync` resolves to
 * `receive_id_type=open_id`.
 *
 * The `event_key` is mapped to an action via `quickCommands`. A configured
 * mapping supplies the prompt / slash-command text; an unmapped key falls back
 * to its label or the raw key so the click is never silently dropped.
 *
 * Returns null for non-menu events or when operator / event_key are absent.
 */
export function parseLarkBotMenuEvent(
  adapterId: string,
  selfBotOpenId: string,
  envelope: LarkEventEnvelope,
  quickCommands: LarkQuickCommand[] | undefined
): NormalizedInboundEvent | null {
  if (envelope.header?.event_type !== "application.bot.menu_v6") return null
  const event = envelope.event as unknown as LarkBotMenuEvent
  const openId = event.operator?.operator_id?.open_id
  const eventKey = event.event_key
  if (!openId || !eventKey) return null

  const mapped = resolveQuickCommand(quickCommands, eventKey)
  const text = mapped?.action.value ?? mapped?.label ?? eventKey

  const conversationKey = buildConversationKey("lark", adapterId, openId)

  return {
    platform: "lark",
    adapterId,
    selfId: selfBotOpenId,
    messageId: `lark.menu:${envelope.header.event_id}`,
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
}

export interface LarkInteractiveEvent {
  operator?: LarkSenderId
  action?: LarkInteractiveAction
  open_message_id?: string
  open_chat_id?: string
  tenant_key?: string
  /** Token Lark expects on the response when the bot updates the card. */
  token?: string
  /** Card-level callback id (rare). */
  callback_id?: string
}

/**
 * Project an `im.interactive_message.action_triggered_v1` envelope into
 * a `ConnectorCallbackEvent` for the bus callback channel.
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
  if (envelope.header?.event_type !== "im.interactive_message.action_triggered_v1") return null
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
  if (action.tag === "select_static") {
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
  } else if (action.tag === "checkbox") {
    actionType = "checkbox"
    value = action.option ?? ""
  } else if (action.tag === "button") {
    actionType = "button"
    value =
      typeof action.value === "object" && action.value && "action" in action.value
        ? String((action.value as Record<string, unknown>).action ?? "")
        : ""
    payload = action.value
  }

  const chatId = event.open_chat_id
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
    originatingMessageId: event.open_message_id,
    conversationKey,
    user,
    timestamp: envelope.header.create_time ? parseInt(envelope.header.create_time, 10) : Date.now(),
    raw: envelope,
  }
}
