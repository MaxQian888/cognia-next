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

export function wecomInboundToA2UI(body: WeComInboundMsgBody): InboundA2UIBlock | null {
  if (!body || typeof body !== "object") return null
  const nodes: InboundA2UINode[] = []

  switch (body.msgtype) {
    case "text":
      if (body.text?.content) nodes.push({ kind: "text", text: body.text.content })
      break
    case "markdown":
      if (body.markdown?.content) nodes.push({ kind: "text", text: body.markdown.content })
      break
    case "image":
      if (body.image?.url) nodes.push({ kind: "image", url: body.image.url })
      break
    case "voice":
      if (body.voice?.url)
        nodes.push({
          kind: "link",
          href: body.voice.url,
          label: body.voice.transcript || "Voice message",
        })
      break
    case "video":
      if (body.video?.url) nodes.push({ kind: "link", href: body.video.url, label: "Video" })
      break
    case "file":
      if (body.file?.url)
        nodes.push({ kind: "link", href: body.file.url, label: body.file.filename || "Attachment" })
      break
    case "mixed":
      for (const item of body.mixed?.msg_item ?? []) {
        if (item.text?.content) nodes.push({ kind: "text", text: item.text.content })
        else if (item.image?.url) nodes.push({ kind: "image", url: item.image.url })
      }
      break
  }

  if (nodes.length === 0) return null
  return { v: 1, source: "wecom", body: nodes, raw: body }
}
