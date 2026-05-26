/**
 * iLink outbound serialisation — text only in v1.
 *
 * Text / markdown / code / mention / A2UI-mirror segments concatenate into a
 * plain-text body, split into ≤2000-char chunks (the gateway rejects longer
 * single items). Media segments degrade to a text marker with a recorded
 * downgrade (outbound media needs AES-128-ECB *encryption* + the CDN upload
 * handshake — out of scope for v1; inbound media is still received).
 */

import type { MessageSegment } from "@/types/connectors/segment"
import { isA2UISegment } from "@/types/connectors/segment"
import type { SegmentDowngrade } from "@/types/connectors/outbound"

export interface WechatPersonalSerialized {
  /** Plain-text chunks (≤2000 chars each), in order. */
  textChunks: string[]
  downgrades: SegmentDowngrade[]
}

const MAX_CHARS = 2000

function chunkText(text: string): string[] {
  if (text.length <= MAX_CHARS) return text.length > 0 ? [text] : []
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += MAX_CHARS) chunks.push(text.slice(i, i + MAX_CHARS))
  return chunks
}

export function serializeIlinkSegments(segments: MessageSegment[]): WechatPersonalSerialized {
  const lines: string[] = []
  const downgrades: SegmentDowngrade[] = []

  for (const seg of segments) {
    if (isA2UISegment(seg)) {
      if (seg.plainTextMirror) lines.push(seg.plainTextMirror)
      continue
    }
    switch (seg.type) {
      case "text":
        if (seg.text) lines.push(seg.text)
        break
      case "markdown":
        if (seg.md) lines.push(seg.md)
        break
      case "code":
        lines.push(seg.code)
        break
      case "mention":
        lines.push(`@${seg.displayName ?? seg.userId}`)
        break
      case "reply":
        lines.push(`> ${seg.snippet}`)
        break
      case "location":
        lines.push(`📍 ${seg.name ?? `${seg.lat},${seg.lon}`}`)
        break
      case "image":
        downgrades.push({ from: "image", to: "text", reason: "ilink_outbound_media_unsupported" })
        lines.push("[图片]")
        break
      case "voice":
        downgrades.push({ from: "voice", to: "text", reason: "ilink_outbound_media_unsupported" })
        lines.push("[语音]")
        break
      case "video":
        downgrades.push({ from: "video", to: "text", reason: "ilink_outbound_media_unsupported" })
        lines.push("[视频]")
        break
      case "file":
        downgrades.push({ from: "file", to: "text", reason: "ilink_outbound_media_unsupported" })
        lines.push(`[文件: ${seg.name}]`)
        break
    }
  }

  return { textChunks: chunkText(lines.join("\n\n").trim()), downgrades }
}
