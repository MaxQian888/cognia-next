/**
 * WeChat Official Account inbound XML → InboundA2UIBlock projection.
 *
 * Unlike the other adapters the OA inbound `raw` is the decrypted message XML
 * string (the Rust webhook handler verifies + decrypts, then emits the inner
 * XML). We reuse `extractXmlField` from parse.ts to read the CDATA fields and
 * project text / image / voice / video / shared-link / location into the
 * inbox's structured view. The link / location branches are reachable now
 * that parse.ts persists those message types (it previously dropped them).
 * Returns null for event pushes and unknown types.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { extractXmlField } from "./parse"

export function wechatOaInboundToA2UI(xml: string): InboundA2UIBlock | null {
  if (typeof xml !== "string" || xml.length === 0) return null
  const msgType = extractXmlField(xml, "MsgType")
  if (!msgType) return null

  const nodes: InboundA2UINode[] = []
  switch (msgType) {
    case "text": {
      const content = extractXmlField(xml, "Content")
      if (content) nodes.push({ kind: "text", text: content })
      break
    }
    case "image": {
      const picUrl = extractXmlField(xml, "PicUrl")
      if (picUrl) nodes.push({ kind: "image", url: picUrl })
      break
    }
    case "voice": {
      const recognition = extractXmlField(xml, "Recognition")
      nodes.push({
        kind: "text",
        text: recognition || "[voice]",
        emphasis: recognition ? undefined : "muted",
      })
      break
    }
    case "video":
    case "shortvideo":
      nodes.push({ kind: "text", text: "[video]", emphasis: "muted" })
      break
    case "link": {
      const title = extractXmlField(xml, "Title")
      const url = extractXmlField(xml, "Url")
      const desc = extractXmlField(xml, "Description")
      if (url) {
        nodes.push({
          kind: "card",
          title: title || undefined,
          subtitle: desc || undefined,
          children: [{ kind: "link", href: url, label: title || url }],
        })
      }
      break
    }
    case "location": {
      const label = extractXmlField(xml, "Label")
      if (label) nodes.push({ kind: "text", text: `📍 ${label}` })
      break
    }
    default:
      return null
  }

  if (nodes.length === 0) return null
  return { v: 1, source: "wechat-oa", body: nodes, raw: xml }
}
