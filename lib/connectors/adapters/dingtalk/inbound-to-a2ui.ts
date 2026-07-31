/**
 * DingTalk bot message → InboundA2UIBlock projection.
 *
 * DingTalk Stream-mode bot messages are text / richText / picture / audio /
 * video / file. richText is an ordered array of text + picture nodes — we
 * project each text run as its own text node and mark inline pictures, giving
 * the inbox a structured view richer than the single joined text part. Audio
 * surfaces its speech-recognition transcript when present. Inbound media
 * carries no direct URL (downloadCode only), so non-text items render as
 * muted markers rather than broken image/link nodes.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import type { DingTalkBotMessage } from "./parse"

export function dingtalkInboundToA2UI(msg: DingTalkBotMessage): InboundA2UIBlock | null {
  if (!msg || typeof msg !== "object") return null
  const nodes: InboundA2UINode[] = []

  switch (msg.msgtype) {
    case "text":
      if (msg.text?.content?.trim()) nodes.push({ kind: "text", text: msg.text.content.trim() })
      break
    case "richText":
      for (const node of msg.richText ?? []) {
        const t = node.text
        if (typeof t === "string" && t.length > 0) {
          nodes.push({ kind: "text", text: t })
        } else if (node.type === "picture" || node.pictureDownloadCode) {
          nodes.push({ kind: "text", text: "[picture]", emphasis: "muted" })
        }
      }
      break
    case "picture":
      nodes.push({ kind: "text", text: "[picture]", emphasis: "muted" })
      break
    case "audio": {
      const recog = msg.content?.recognition
      const hasText = typeof recog === "string" && recog.length > 0
      nodes.push({
        kind: "text",
        text: hasText ? (recog as string) : "[audio]",
        emphasis: hasText ? undefined : "muted",
      })
      break
    }
    case "video":
      nodes.push({ kind: "text", text: "[video]", emphasis: "muted" })
      break
    case "file": {
      const name = msg.content?.fileName
      nodes.push({
        kind: "text",
        text: typeof name === "string" ? `[file: ${name}]` : "[file]",
        emphasis: "muted",
      })
      break
    }
  }

  if (nodes.length === 0) return null
  return { v: 1, source: "dingtalk", body: nodes, raw: msg }
}
