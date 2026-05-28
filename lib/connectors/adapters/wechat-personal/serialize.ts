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
import { buildIlinkA2UISurface } from "./a2ui-mapper"

export interface WechatPersonalSerialized {
  /** Plain-text chunks (≤2000 chars each), in order. */
  textChunks: string[]
  downgrades: SegmentDowngrade[]
}

export interface WechatPersonalSerializeContext {
  adapterId: string
  conversationKey: string
}

const MAX_CHARS = 2000

function chunkText(text: string): string[] {
  if (text.length <= MAX_CHARS) return text.length > 0 ? [text] : []
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += MAX_CHARS) chunks.push(text.slice(i, i + MAX_CHARS))
  return chunks
}

/**
 * Serialise outbound segments for iLink. Accepts an optional `ctx` so
 * A2UI segments can be routed through the per-adapter mapper that records
 * `connectorCallbackBindings` rows + populates the numeric-action
 * registry for future inbound digit replies. Without `ctx` the function
 * falls back to the legacy "drop in seg.plainTextMirror" path so unit
 * tests that don't care about A2UI bindings can keep their existing call
 * shape.
 */
export async function serializeIlinkSegments(
  segments: MessageSegment[],
  ctx?: WechatPersonalSerializeContext
): Promise<WechatPersonalSerialized> {
  const lines: string[] = []
  const downgrades: SegmentDowngrade[] = []

  for (const seg of segments) {
    if (isA2UISegment(seg)) {
      if (ctx) {
        const { textMirror } = await buildIlinkA2UISurface({
          adapterId: ctx.adapterId,
          conversationKey: ctx.conversationKey,
          segment: seg,
        })
        if (textMirror) lines.push(textMirror)
      } else if (seg.plainTextMirror) {
        lines.push(seg.plainTextMirror)
      }
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
