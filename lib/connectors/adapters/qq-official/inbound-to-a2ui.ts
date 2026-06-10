/**
 * QQ Official Bot gateway dispatch → InboundA2UIBlock projection.
 *
 * The v1 parser normalises only the text `content`; this mapper projects that
 * (stripping a leading channel `<@!id>` mention, a no-op for c2c/group/direct)
 * plus any inbound `attachments` QQ includes on the raw dispatch — images
 * render as image nodes, other files as link nodes — so the structured view
 * shows media the flat text part would drop. Returns null when nothing
 * renderable is present.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { stripChannelMention, type QQDispatch } from "./parse"

interface QQAttachment {
  url?: string
  content_type?: string
  filename?: string
}

export function qqOfficialInboundToA2UI(dispatch: QQDispatch): InboundA2UIBlock | null {
  if (!dispatch || typeof dispatch !== "object") return null
  const d = dispatch.d
  if (!d) return null

  const nodes: InboundA2UINode[] = []

  const text = stripChannelMention(d.content ?? "")
  if (text) nodes.push({ kind: "text", text })

  // QQ may attach images/files on the raw dispatch even though the v1 parser
  // only normalises text — surface them defensively.
  const attachments = (d as { attachments?: QQAttachment[] }).attachments
  for (const att of attachments ?? []) {
    if (!att?.url) continue
    if ((att.content_type ?? "").startsWith("image/")) {
      nodes.push({ kind: "image", url: att.url, alt: att.filename })
    } else {
      nodes.push({ kind: "link", href: att.url, label: att.filename || "Attachment" })
    }
  }

  if (nodes.length === 0) return null
  return { v: 1, source: "qq-official", body: nodes, raw: dispatch }
}
