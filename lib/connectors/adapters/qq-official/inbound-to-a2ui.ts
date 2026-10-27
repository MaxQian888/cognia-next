/**
 * QQ Official Bot gateway dispatch → InboundA2UIBlock projection.
 *
 * Reuses parser-owned attachment normalization so cached media matches the
 * original node exactly once. Channel mentions are stripped only in the
 * channel @ scene. References remain read-only message context.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { qqAttachmentSegments, stripChannelMention, type QQDispatch } from "./parse"

export function qqOfficialInboundToA2UI(dispatch: QQDispatch): InboundA2UIBlock | null {
  if (!dispatch || typeof dispatch !== "object") return null
  const d = dispatch.d
  if (!d) return null

  const nodes: InboundA2UINode[] = []

  if (typeof d.message_reference?.message_id === "string" && d.message_reference.message_id)
    nodes.push({ kind: "reply_context", replyToMessageId: d.message_reference.message_id })
  const rawText = typeof d.content === "string" ? d.content : ""
  const text = dispatch.t === "AT_MESSAGE_CREATE" ? stripChannelMention(rawText) : rawText.trim()
  if (text) nodes.push({ kind: "text", text })

  for (const segment of qqAttachmentSegments(d.attachments)) {
    if (segment.type === "image") nodes.push({ kind: "image", url: segment.url, alt: segment.alt })
    else if (segment.type === "voice")
      nodes.push({ kind: "link", href: segment.url, label: "Voice message" })
    else if (segment.type === "video")
      nodes.push({ kind: "link", href: segment.url, label: "Video" })
    else if (segment.type === "file")
      nodes.push({
        kind: "link",
        href: segment.url,
        label: segment.name === "attachment" ? "Attachment" : segment.name,
      })
  }

  if (nodes.length === 0) return null
  return { v: 1, source: "qq-official", body: nodes, raw: dispatch }
}
