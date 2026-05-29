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

export interface WechatCustomMessage {
  touser: string
  msgtype: "text"
  text: { content: string }
}

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
      default:
        break
    }
  }
  return parts.join("\n")
}

export function serializeOutbound(req: OutboundRequest): WechatCustomMessage | null {
  const ref = req.conversationRef as { openId?: string }
  const touser = ref.openId
  if (!touser) return null
  const content = buildWechatContent(req.segments)
  return { touser, msgtype: "text", text: { content } }
}
