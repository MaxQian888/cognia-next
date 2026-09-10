/**
 * OutboundRequest → WeChat 客服 (customer-service) message payload.
 *
 *   POST /cgi-bin/message/custom/send?access_token=<token>
 *     { touser, msgtype: "text", text: { content } }
 *
 * v1 sends text only; richer segments are flattened into the text body.
 */

import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"

export type WechatCustomMessage =
  | { touser: string; msgtype: "text"; text: { content: string } }
  | { touser: string; msgtype: "image"; image: { media_id: string } }
  | { touser: string; msgtype: "voice"; voice: { media_id: string } }
  | { touser: string; msgtype: "video"; video: { media_id: string; thumb_media_id: string } }

export function buildWechatContent(segments: MessageSegment[]): string {
  const parts: string[] = []
  for (const seg of segments) {
    switch (seg.type) {
      case "text":
        parts.push(seg.text)
        break
      case "markdown":
        parts.push(seg.md)
        break
      case "code":
        parts.push(seg.code)
        break
      case "image":
      case "video":
      case "voice":
      case "file":
        parts.push(`[${seg.type}] ${seg.url}`)
        break
      case "a2ui":
        parts.push(seg.plainTextMirror || "[interactive message]")
        break
      case "emoji":
        parts.push(seg.code)
        break
      case "mention":
        parts.push(`@${seg.displayName ?? seg.userId}`)
        break
      case "location":
        parts.push(`${seg.name ?? "Location"}: ${seg.lat},${seg.lon}`)
        break
      case "poll":
        parts.push(
          [seg.question, ...seg.options.map((option, index) => `${index + 1}. ${option}`)].join(
            "\n"
          )
        )
        break
      case "reply":
        parts.push(`> ${seg.snippet}`)
        break
      case "card":
        throw new Error("WeChat OA does not support opaque native cards")
    }
  }
  return parts.join("\n")
}

export function serializeOutbound(
  req: OutboundRequest
): Extract<WechatCustomMessage, { msgtype: "text" }> | null {
  const ref = req.conversationRef as { openId?: string }
  const touser = ref.openId
  if (!touser) return null
  const content = buildWechatContent(req.segments)
  return { touser, msgtype: "text", text: { content } }
}
