/**
 * DingTalk Stream-mode bot message → NormalizedInboundEvent.
 *
 * The Stream frame for topic `/v1.0/im/bot/messages/get` carries (after the
 * outer frame's `data` JSON-string is parsed) a bot message payload. DingTalk
 * only pushes messages directed at the bot — every 1:1 message, and group
 * messages that @-mention the bot — so each parsed event is `selfMentioned`.
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { buildConversationKey } from "@/types/connectors/event"

/** Raw bot-message payload (topic `/v1.0/im/bot/messages/get`). */
export interface DingTalkBotMessage {
  conversationId: string
  /** `"1"` = 1:1 private chat, `"2"` = group chat. */
  conversationType: string
  conversationTitle?: string
  senderId?: string
  senderNick?: string
  senderStaffId?: string
  senderCorpId?: string
  chatbotCorpId?: string
  chatbotUserId?: string
  robotCode?: string
  isAdmin?: boolean
  msgId: string
  createAt?: number
  sessionWebhook?: string
  sessionWebhookExpiredTime?: number
  msgtype: string
  text?: { content?: string }
  content?: Record<string, unknown>
  richText?: Array<Record<string, unknown>>
}

/** Flatten a `richText` array into plain text (ignoring inline pictures). */
function richTextToPlain(rich: Array<Record<string, unknown>>): string {
  const parts: string[] = []
  for (const node of rich) {
    const t = node.text
    if (typeof t === "string" && t.length > 0) parts.push(t)
    else if (node.type === "picture" || node.pictureDownloadCode) parts.push("[picture]")
  }
  return parts.join("")
}

/** Derive the visible text for a bot message across the supported msgtypes. */
function extractText(msg: DingTalkBotMessage): string {
  switch (msg.msgtype) {
    case "text":
      return typeof msg.text?.content === "string" ? msg.text.content.trim() : ""
    case "richText":
      return Array.isArray(msg.richText) ? richTextToPlain(msg.richText).trim() : ""
    case "picture":
      return "[picture]"
    case "audio": {
      const recog = msg.content?.recognition
      return typeof recog === "string" && recog.length > 0 ? recog : "[audio]"
    }
    case "video":
      return "[video]"
    case "file": {
      const name = msg.content?.fileName
      return typeof name === "string" ? `[file:${name}]` : "[file]"
    }
    default:
      return `[${msg.msgtype}]`
  }
}

/**
 * Parse a DingTalk bot message into a NormalizedInboundEvent. Returns `null`
 * when the payload has no usable id (defensive — a malformed frame should not
 * crash the inbound loop).
 */
export function parseDingTalkBotMessage(
  adapterId: string,
  selfId: string,
  msg: DingTalkBotMessage
): NormalizedInboundEvent | null {
  if (!msg || !msg.msgId || !msg.conversationId) return null

  const isGroup = msg.conversationType === "2"
  const remoteUserId = msg.senderStaffId || msg.senderId || "unknown"
  const text = extractText(msg)
  const segments: MessageSegment[] = [{ type: "text", text }]

  return {
    platform: "dingtalk",
    adapterId,
    selfId: selfId || msg.chatbotUserId || "",
    messageId: msg.msgId,
    conversationRef: {
      platform: "dingtalk",
      adapterId,
      conversationType: msg.conversationType,
      // 1:1 replies target the staff id; group replies target the conversation.
      userId: remoteUserId,
      openConversationId: msg.conversationId,
      robotCode: msg.robotCode ?? "",
    },
    conversationKey: buildConversationKey("dingtalk", adapterId, msg.conversationId),
    sender: {
      id: remoteUserId,
      platform: "dingtalk",
      adapterId,
      remoteUserId,
      displayName: msg.senderNick,
    },
    channel: {
      id: msg.conversationId,
      name: msg.conversationTitle,
      kind: isGroup ? "group" : "private",
      platformChannelId: msg.conversationId,
    },
    segments,
    plainText: text,
    // DingTalk only delivers messages addressed to the bot.
    mentions: { selfMentioned: true, users: [] },
    timestamp: typeof msg.createAt === "number" ? msg.createAt : Date.now(),
    raw: msg,
  }
}
