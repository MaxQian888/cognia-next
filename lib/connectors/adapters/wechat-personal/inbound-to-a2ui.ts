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
import { ilinkMediaUrl, ILINK_ITEM, type IlinkItem, type IlinkMessage } from "./protocol"

function itemToNode(item: IlinkItem): InboundA2UINode | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null
  switch (item.type) {
    case ILINK_ITEM.text:
      return typeof item.text_item?.text === "string" && item.text_item.text
        ? { kind: "text", text: item.text_item.text }
        : null
    case ILINK_ITEM.image:
      return ilinkMediaUrl(item.image_item)
        ? { kind: "image", url: `wechat-personal-media:${ilinkMediaUrl(item.image_item)!}` }
        : null
    case ILINK_ITEM.voice:
      return ilinkMediaUrl(item.voice_item)
        ? {
            kind: "link",
            href: `wechat-personal-media:${ilinkMediaUrl(item.voice_item)!}`,
            label:
              typeof item.voice_item?.text === "string" && item.voice_item.text
                ? item.voice_item.text
                : typeof item.voice_item?.transcript === "string" && item.voice_item.transcript
                  ? item.voice_item.transcript
                  : "Voice message",
          }
        : typeof item.voice_item?.text === "string" && item.voice_item.text
          ? { kind: "text", text: item.voice_item.text }
          : null
    case ILINK_ITEM.video:
      return ilinkMediaUrl(item.video_item)
        ? {
            kind: "link",
            href: `wechat-personal-media:${ilinkMediaUrl(item.video_item)!}`,
            label: "Video",
          }
        : null
    case ILINK_ITEM.file:
      return ilinkMediaUrl(item.file_item)
        ? {
            kind: "link",
            href: `wechat-personal-media:${ilinkMediaUrl(item.file_item)!}`,
            label:
              typeof item.file_item?.file_name === "string" && item.file_item.file_name
                ? item.file_item.file_name
                : "Attachment",
          }
        : null
    default:
      return null
  }
}

export function wechatPersonalInboundToA2UI(msg: IlinkMessage): InboundA2UIBlock | null {
  if (!msg || typeof msg !== "object") return null
  const nodes: InboundA2UINode[] = []
  for (const item of Array.isArray(msg.item_list) ? msg.item_list : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const quoted = item.ref_msg?.message_item ? itemToNode(item.ref_msg.message_item) : null
    const preview = [
      typeof item.ref_msg?.title === "string" ? item.ref_msg.title : undefined,
      quoted?.kind === "text" ? quoted.text : undefined,
    ]
      .filter(Boolean)
      .join(" | ")
    if (preview) nodes.push({ kind: "text", text: `[reply:${preview}]` })
    if (quoted && quoted.kind !== "text") nodes.push(quoted)
    const node = itemToNode(item)
    if (node) nodes.push(node)
  }
  if (nodes.length === 0) return null
  return { v: 1, source: "wechat-personal", body: nodes, raw: msg }
}
