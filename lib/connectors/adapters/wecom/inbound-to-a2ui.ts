/**
 * WeCom (企业微信智能机器人) inbound message → InboundA2UIBlock projection.
 *
 * Surfaces the structured view of an `aibot_msg_callback` body: markdown text,
 * inline images, and voice/video/file attachments as link nodes (the flat
 * message parts only carry `[image: url]` / `[type]` placeholders). The
 * `mixed` type interleaves text + image items in order. Mirrors the Telegram
 * mapper convention — image → image node, other media → link node.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import type { WeComInboundMsgBody } from "./protocol"
import { wecomBodyToSegments } from "./parse"

function bodyNodes(body: Parameters<typeof wecomBodyToSegments>[0]): InboundA2UINode[] {
  const nodes: InboundA2UINode[] = []
  for (const segment of wecomBodyToSegments(body)) {
    switch (segment.type) {
      case "text":
        nodes.push({ kind: "text", text: segment.text })
        break
      case "markdown":
        nodes.push({ kind: "text", text: segment.md, format: "markdown" })
        break
      case "image":
        nodes.push({ kind: "image", url: segment.url })
        break
      case "voice":
        nodes.push({
          kind: "link",
          href: segment.url,
          label: segment.transcript || "Voice message",
        })
        break
      case "video":
        nodes.push({ kind: "link", href: segment.url, label: "Video" })
        break
      case "file":
        nodes.push({ kind: "link", href: segment.url, label: body.file?.filename || "Attachment" })
        break
    }
  }
  return nodes
}

export function wecomInboundToA2UI(body: WeComInboundMsgBody): InboundA2UIBlock | null {
  if (!body || typeof body !== "object") return null
  const quoted = body.quote ? bodyNodes(body.quote) : []
  const nodes: InboundA2UINode[] = [
    ...(quoted.length ? [{ kind: "card" as const, children: quoted }] : []),
    ...bodyNodes(body),
  ]

  if (nodes.length === 0) return null
  return { v: 1, source: "wecom", body: nodes, raw: body }
}
