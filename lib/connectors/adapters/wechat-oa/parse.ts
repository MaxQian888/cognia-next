/**
 * WeChat Official Account inbound XML → NormalizedInboundEvent.
 *
 * The Rust webhook handler verifies the signature, decrypts the safe-mode
 * payload, and emits the inner message XML. This parser reads the WeChat
 * message fields (CDATA-wrapped) and projects text / image / voice / video /
 * link / location messages. Public-account chats are always 1:1, so
 * `selfMentioned` is true and the at-gate's mention strategy passes.
 *
 * Event pushes: `subscribe` becomes a `kind:"system"` / `member_added` event
 * (the bus welcome flow consumes it and can greet the new follower), menu
 * `CLICK` becomes a normalized text message carrying the EventKey; other
 * events are dropped.
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

interface Envelope {
  adapterId: string
  selfId: string
  fromUser: string
  conversationKey: string
  sender: PlatformIdentity
  timestamp: number
}

function buildEnvelope(
  adapterId: string,
  selfId: string,
  fromUser: string,
  createTime: number
): Envelope {
  const conversationKey = buildConversationKey("wechat-oa", adapterId, fromUser)
  return {
    adapterId,
    selfId,
    fromUser,
    conversationKey,
    sender: {
      id: `wxoa:${adapterId}:${fromUser}`,
      platform: "wechat-oa",
      adapterId,
      remoteUserId: fromUser,
    },
    timestamp: createTime > 0 ? createTime * 1000 : Date.now(),
  }
}

function buildEvent(
  env: Envelope,
  messageId: string,
  segments: MessageSegment[],
  xml: string,
  overrides?: Partial<Pick<NormalizedInboundEvent, "kind" | "systemKind" | "mentions">>
): NormalizedInboundEvent {
  return {
    platform: "wechat-oa",
    adapterId: env.adapterId,
    selfId: env.selfId,
    messageId,
    conversationRef: { platform: "wechat-oa", adapterId: env.adapterId, openId: env.fromUser },
    conversationKey: env.conversationKey,
    sender: env.sender,
    channel: { id: env.conversationKey, kind: "private", platformChannelId: env.fromUser },
    segments,
    plainText: segmentsToPlainText(segments),
    mentions: { selfMentioned: true, users: [] },
    timestamp: env.timestamp,
    raw: xml,
    kind: "create",
    ...overrides,
  }
}

/**
 * Project an event push. `subscribe` mirrors what other adapters emit when
 * the bot is added to a chat (`kind:"system"` + `systemKind:"member_added"`,
 * empty segments — see OneBot's `v11SystemEvent` and the bus's
 * `applySystemEvent`), so `maybeSendWelcome` can greet the new follower.
 */
function parseEventPush(env: Envelope, xml: string): NormalizedInboundEvent | null {
  const event = extractXmlField(xml, "Event")
  if (!event) return null
  switch (event) {
    case "subscribe":
      return buildEvent(env, `event:subscribe:${env.timestamp}:${env.fromUser}`, [], xml, {
        kind: "system",
        systemKind: "member_added",
        mentions: { selfMentioned: false, users: [] },
      })
    case "unsubscribe":
      // The follower left; there is nothing to persist and no one left to
      // reply to. Dropped deliberately (no member_removed audit in v1).
      return null
    case "CLICK": {
      // A custom-menu click opens the 48h customer-service window; surface it
      // as a normalized text message whose plainText is the EventKey so quick
      // commands / the AI loop can respond to it.
      const eventKey = extractXmlField(xml, "EventKey")
      if (!eventKey) return null
      return buildEvent(
        env,
        `event:CLICK:${env.timestamp}:${env.fromUser}`,
        [{ type: "text", text: eventKey }],
        xml
      )
    }
    default:
      // VIEW (link opened in the browser), SCAN, LOCATION reporting, etc.
      // carry no conversational intent — dropped.
      return null
  }
}

export function parseWechatOaXml(
  adapterId: string,
  selfId: string,
  xml: string
): NormalizedInboundEvent | null {
  const msgType = extractXmlField(xml, "MsgType")
  const fromUser = extractXmlField(xml, "FromUserName")
  if (!msgType || !fromUser) return null

  const createTime = Number(extractXmlField(xml, "CreateTime") ?? "0")
  const env = buildEnvelope(adapterId, selfId, fromUser, createTime)

  if (msgType === "event") return parseEventPush(env, xml)

  const msgId = extractXmlField(xml, "MsgId") ?? `${createTime}:${fromUser}`

  // GAP: media upload/download — `wxmedia://<MediaId>` pseudo-URLs are not
  // resolved to fetchable bytes (needs /cgi-bin/media/get on the send-path
  // token); downstream consumers treat them as opaque references.
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
    case "link": {
      // No dedicated link segment exists in the MessageSegment union; carry
      // title + description + url as text so triggers and the AI loop see it.
      const title = extractXmlField(xml, "Title")
      const desc = extractXmlField(xml, "Description")
      const url = extractXmlField(xml, "Url")
      const text = [title, desc, url].filter(Boolean).join("\n")
      if (text) segments.push({ type: "text", text })
      break
    }
    case "location": {
      // Location_X is latitude, Location_Y is longitude.
      const lat = Number(extractXmlField(xml, "Location_X"))
      const lon = Number(extractXmlField(xml, "Location_Y"))
      const label = extractXmlField(xml, "Label")
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        segments.push({ type: "location", lat, lon, name: label || undefined })
      } else if (label) {
        segments.push({ type: "text", text: `Location: ${label}` })
      }
      break
    }
    default:
      return null
  }
  if (segments.length === 0 && msgType !== "text") return null

  return buildEvent(env, msgId, segments, xml)
}
