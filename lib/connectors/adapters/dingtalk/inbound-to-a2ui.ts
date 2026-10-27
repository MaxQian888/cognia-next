/**
 * DingTalk bot message → InboundA2UIBlock projection.
 *
 * DingTalk Stream-mode bot messages are text / richText / picture / audio /
 * video / file. richText is an ordered array of text + picture nodes — we
 * project each text run as its own text node and mark inline pictures, giving
 * the inbox a structured view richer than the single joined text part. Audio
 * surfaces its speech-recognition transcript when present. The parser owns
 * download references; shared enrichment adds already cached display bytes.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { dingtalkMessageSegments, type DingTalkBotMessage } from "./parse"

export function dingtalkInboundToA2UI(msg: DingTalkBotMessage): InboundA2UIBlock | null {
  if (!msg || typeof msg !== "object") return null
  const nodes: InboundA2UINode[] = []

  for (const segment of dingtalkMessageSegments(msg)) {
    switch (segment.type) {
      case "text":
        if (segment.text)
          nodes.push({
            kind: "text",
            text: segment.text,
            ...(["picture", "video", "file"].includes(msg.msgtype) ||
            (msg.msgtype === "audio" && segment.text === "[audio]")
              ? { emphasis: "muted" as const }
              : {}),
          })
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
        nodes.push({ kind: "link", href: segment.url, label: segment.name })
        break
    }
  }

  if (nodes.length === 0) return null
  return { v: 1, source: "dingtalk", body: nodes, raw: msg }
}
