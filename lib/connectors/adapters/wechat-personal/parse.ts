/**
 * iLink inbound → `NormalizedInboundEvent`.
 *
 * Only user-direction messages (`message_type === 1`) are inbound. Each is a
 * 1:1 personal-account conversation keyed by the peer's `from_user_id`. The
 * `WeComConversationRef` analogue here carries the `context_token` (mandatory
 * for the reply) and `session_id`. Media item `aes_key`s ride on `event.raw`
 * so the media resolver can decrypt lazily.
 */

import type { NormalizedInboundEvent, ConversationReference } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"
import type { ConnectorCallbackEvent } from "@/types/connectors/interaction"
import { ILINK_ITEM, ILINK_MSG, type IlinkItem, type IlinkMessage } from "./protocol"
import { consumeNumericAction } from "./numeric-action-registry"

export interface WechatPersonalConversationRef extends ConversationReference {
  platform: "wechat-personal"
  adapterId: string
  /** Peer user id (`...@im.wechat`) — the conversation anchor + reply target. */
  userId: string
  /** Mandatory reply anchor echoed back on `sendmessage`. */
  contextToken: string
  sessionId?: string
}

function itemToSegment(item: IlinkItem): MessageSegment | null {
  switch (item.type) {
    case ILINK_ITEM.text:
      return item.text_item?.text ? { type: "text", text: item.text_item.text } : null
    case ILINK_ITEM.image:
      return item.image_item?.url ? { type: "image", url: item.image_item.url } : null
    case ILINK_ITEM.voice:
      return item.voice_item?.url
        ? { type: "voice", url: item.voice_item.url, transcript: item.voice_item.transcript }
        : null
    case ILINK_ITEM.video:
      return item.video_item?.url ? { type: "video", url: item.video_item.url } : null
    case ILINK_ITEM.file:
      return item.file_item?.url
        ? {
            type: "file",
            url: item.file_item.url,
            name: item.file_item.file_name ?? "file",
            mimeType: "application/octet-stream",
            sizeBytes: 0,
          }
        : null
    default:
      return null
  }
}

/**
 * Normalise an inbound iLink message. Returns `null` for bot-direction
 * messages, missing `context_token`, or empty content.
 */
export function parseIlinkMessage(
  adapterId: string,
  msg: IlinkMessage,
  now: number = Date.now()
): NormalizedInboundEvent | null {
  if (msg.message_type !== ILINK_MSG.fromUser) return null
  if (!msg.from_user_id || !msg.context_token) return null

  const segments = (msg.item_list ?? [])
    .map(itemToSegment)
    .filter((s): s is MessageSegment => s !== null)
  if (segments.length === 0) return null

  const conversationRef: WechatPersonalConversationRef = {
    platform: "wechat-personal",
    adapterId,
    userId: msg.from_user_id,
    contextToken: msg.context_token,
    sessionId: msg.session_id,
  }
  const conversationKey = buildConversationKey("wechat-personal", adapterId, msg.from_user_id)
  const plainText = segmentsToPlainText(segments).trim()

  return {
    platform: "wechat-personal",
    adapterId,
    selfId: msg.to_user_id ?? "",
    // Personal WeChat gives no stable per-message id; derive one from the
    // context_token + session so the dedup ledger has a key.
    messageId: `${msg.context_token}:${msg.session_id ?? ""}:${now}`,
    conversationRef,
    conversationKey,
    sender: {
      id: msg.from_user_id,
      platform: "wechat-personal",
      adapterId,
      remoteUserId: msg.from_user_id,
    },
    channel: { id: msg.from_user_id, kind: "private", platformChannelId: msg.from_user_id },
    segments,
    plainText: plainText.length > 0 ? plainText : "[message]",
    mentions: { selfMentioned: false, users: [] },
    timestamp: now,
    raw: msg,
    kind: "create",
  }
}

const SINGLE_DIGIT_RE = /^\s*([1-9])\s*$/

function extractTextForNumeric(msg: IlinkMessage): string {
  const items = msg.item_list ?? []
  for (const item of items) {
    if (item.type === ILINK_ITEM.text && item.text_item?.text) {
      return item.text_item.text
    }
  }
  return ""
}

/**
 * Detect a numeric-only reply that selects a previously-emitted button
 * and project it into a `ConnectorCallbackEvent` keyed by the wireActionId
 * the outbound mapper stashed in `numeric-action-registry`. Returns null
 * for any non-numeric reply or when no live binding matches.
 *
 * The function CONSUMES the registry entry — a second tap on the same
 * digit won't fire twice, matching native button behaviour.
 *
 * `surfaceId` / `componentId` are intentionally left empty; the bus's
 * `resolveCallbackBinding(adapterId, triggerId)` reads the persisted
 * binding row and fills both in before dispatching to the kind-specific
 * handler. That keeps this parser ignorant of binding shape.
 */
export function tryParseNumericCallback(
  adapterId: string,
  msg: IlinkMessage,
  now: number = Date.now()
): ConnectorCallbackEvent | null {
  if (msg.message_type !== ILINK_MSG.fromUser) return null
  if (!msg.from_user_id || !msg.context_token) return null
  const text = extractTextForNumeric(msg)
  if (!text) return null
  const match = SINGLE_DIGIT_RE.exec(text)
  if (!match) return null
  const numeric = Number.parseInt(match[1], 10)
  const conversationKey = buildConversationKey("wechat-personal", adapterId, msg.from_user_id)
  const wireActionId = consumeNumericAction(conversationKey, numeric, now)
  if (!wireActionId) return null

  const userId = msg.from_user_id
  // Stable per-callback id so the bus's dedup ledger (`callback`
  // namespace) drops a redelivered iLink poll. Using the wireActionId
  // keeps the dedup tight even when the same digit is re-used across
  // surfaces (each surface mints a fresh wireActionId).
  const triggerId = wireActionId
  return {
    platform: "wechat-personal",
    adapterId,
    selfId: msg.to_user_id ?? "",
    triggerId,
    surfaceId: "",
    componentId: undefined,
    actionType: "button",
    value: String(numeric),
    conversationKey,
    user: {
      id: userId,
      platform: "wechat-personal",
      adapterId,
      remoteUserId: userId,
    },
    timestamp: now,
    raw: msg,
  }
}
