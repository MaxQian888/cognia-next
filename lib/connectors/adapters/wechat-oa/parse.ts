/**
 * WeChat Official Account inbound XML → NormalizedInboundEvent.
 *
 * The Rust webhook handler verifies the signature, decrypts the safe-mode
 * payload, and emits the inner message XML. This parser reads the WeChat
 * message fields (CDATA-wrapped) and projects text / image / voice / video
 * messages. Public-account chats are always 1:1, so `selfMentioned` is true
 * and the at-gate's mention strategy passes.
 *
 * Event pushes (subscribe / unsubscribe / menu click) are not message events;
 * they return null in v1 (no message persistence).
 */

import type { NormalizedInboundEvent, PlatformIdentity } from "@/types/connectors/event"
import { buildConversationKey } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"

/** Read a WeChat XML field, unwrapping a `<![CDATA[...]]>` when present. */
export function extractXmlField(xml: string, field: string): string | undefined {
  const re = new RegExp(`<${field}>([\\s\\S]*?)</${field}>`)
  const m = re.exec(xml)
  if (!m) return undefined
  let inner = m[1].trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner)
  if (cdata) inner = cdata[1]
  return inner
}

export function parseWechatOaXml(
  adapterId: string,
  selfId: string,
  xml: string
): NormalizedInboundEvent | null {
  const msgType = extractXmlField(xml, "MsgType")
  const fromUser = extractXmlField(xml, "FromUserName")
  if (!msgType || !fromUser) return null
  // Event pushes are not chat messages in v1.
  if (msgType === "event") return null

  const createTime = Number(extractXmlField(xml, "CreateTime") ?? "0")
  const msgId = extractXmlField(xml, "MsgId") ?? `${createTime}:${fromUser}`

  const segments: MessageSegment[] = []
  switch (msgType) {
    case "text": {
      const content = extractXmlField(xml, "Content")
      if (content) segments.push({ type: "text", text: content })
      break
    }
    case "image": {
      const picUrl = extractXmlField(xml, "PicUrl")
      const mediaId = extractXmlField(xml, "MediaId")
      segments.push({ type: "image", url: picUrl ?? `wxmedia://${mediaId ?? ""}` })
      break
    }
    case "voice": {
      const mediaId = extractXmlField(xml, "MediaId")
      const recognition = extractXmlField(xml, "Recognition")
      segments.push({
        type: "voice",
        url: `wxmedia://${mediaId ?? ""}`,
        transcript: recognition || undefined,
      })
      break
    }
    case "video":
    case "shortvideo": {
      const mediaId = extractXmlField(xml, "MediaId")
      segments.push({ type: "video", url: `wxmedia://${mediaId ?? ""}` })
      break
    }
    default:
      return null
  }

  const conversationKey = buildConversationKey("wechat-oa", adapterId, fromUser)
  const sender: PlatformIdentity = {
    id: `wxoa:${adapterId}:${fromUser}`,
    platform: "wechat-oa",
    adapterId,
    remoteUserId: fromUser,
  }

  return {
    platform: "wechat-oa",
    adapterId,
    selfId,
    messageId: msgId,
    conversationRef: { platform: "wechat-oa", adapterId, openId: fromUser },
    conversationKey,
    sender,
    channel: { id: conversationKey, kind: "private", platformChannelId: fromUser },
    segments,
    plainText: segmentsToPlainText(segments),
    mentions: { selfMentioned: true, users: [] },
    timestamp: createTime > 0 ? createTime * 1000 : Date.now(),
    raw: xml,
    kind: "create",
  }
}
