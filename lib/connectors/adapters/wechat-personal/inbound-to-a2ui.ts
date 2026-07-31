/**
 * Personal WeChat (iLink) inbound message → InboundA2UIBlock projection.
 *
 * An iLink message carries an ordered `item_list` of typed items (text /
 * image / voice / video / file). We project each into the inbox's structured
 * view so inbound images render as images and attachments as links, rather
 * than the `[image: url]` / `[type]` placeholders the flat parts carry.
 *
 * Numeric-menu replies are handled separately as callbacks
 * (`tryParseNumericCallback` in parse.ts), not here.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { ILINK_ITEM, type IlinkItem, type IlinkMessage } from "./protocol"

function itemToNode(item: IlinkItem): InboundA2UINode | null {
  switch (item.type) {
    case ILINK_ITEM.text:
      return item.text_item?.text ? { kind: "text", text: item.text_item.text } : null
    case ILINK_ITEM.image:
      return item.image_item?.url ? { kind: "image", url: item.image_item.url } : null
    case ILINK_ITEM.voice:
      return item.voice_item?.url
        ? {
            kind: "link",
            href: item.voice_item.url,
            label: item.voice_item.transcript || "Voice message",
          }
        : null
    case ILINK_ITEM.video:
      return item.video_item?.url
        ? { kind: "link", href: item.video_item.url, label: "Video" }
        : null
    case ILINK_ITEM.file:
      return item.file_item?.url
        ? {
            kind: "link",
            href: item.file_item.url,
            label: item.file_item.file_name || "Attachment",
          }
        : null
    default:
      return null
  }
}

export function wechatPersonalInboundToA2UI(msg: IlinkMessage): InboundA2UIBlock | null {
  if (!msg || typeof msg !== "object") return null
  const nodes: InboundA2UINode[] = []
  for (const item of msg.item_list ?? []) {
    const node = itemToNode(item)
    if (node) nodes.push(node)
  }
  if (nodes.length === 0) return null
  return { v: 1, source: "wechat-personal", body: nodes, raw: msg }
}
