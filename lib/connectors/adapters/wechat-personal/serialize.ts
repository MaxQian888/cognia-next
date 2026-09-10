import type { MessageSegment } from "@/types/connectors/segment"
import { isA2UISegment } from "@/types/connectors/segment"
import type { SegmentDowngrade } from "@/types/connectors/outbound"
import { buildIlinkA2UISurface } from "./a2ui-mapper"

export type IlinkOutboundMedia = Extract<
  MessageSegment,
  { type: "image" | "voice" | "video" | "file" }
>
export type IlinkOutboundPart =
  { type: "text"; text: string } | { type: "media"; segment: IlinkOutboundMedia }

export interface WechatPersonalSerialized {
  parts: IlinkOutboundPart[]
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
  let remaining = text
  while (remaining.length > 0) {
    let end = Math.min(MAX_CHARS, remaining.length)
    if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end -= 1
    chunks.push(remaining.slice(0, end))
    remaining = remaining.slice(end)
  }
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
  const parts: IlinkOutboundPart[] = []
  const flushText = () => {
    parts.push(...chunkText(lines.join("\n\n")).map((text) => ({ type: "text" as const, text })))
    lines.length = 0
  }
  const downgrades: SegmentDowngrade[] = []
  let numericOffset = 0

  for (const seg of segments) {
    if (isA2UISegment(seg)) {
      if (ctx) {
        const { textMirror, numberedCount } = await buildIlinkA2UISurface({
          adapterId: ctx.adapterId,
          conversationKey: ctx.conversationKey,
          segment: seg,
          numericOffset,
        })
        numericOffset += numberedCount
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
      case "emoji":
        lines.push(`:${seg.code}:`)
        downgrades.push({ from: "emoji", to: "text", reason: "ilink_no_native_emoji_segment" })
        break
      case "poll":
        lines.push(
          [seg.question, ...seg.options.map((option, index) => `${index + 1}. ${option}`)].join(
            "\n"
          )
        )
        downgrades.push({ from: "poll", to: "text", reason: "ilink_no_native_poll" })
        break
      case "card":
        lines.push(
          `[${seg.card.kind}] ${typeof seg.card.payload === "string" ? seg.card.payload : (JSON.stringify(seg.card.payload) ?? "")}`
        )
        downgrades.push({ from: "card", to: "text", reason: "ilink_no_native_card" })
        break
      case "image":
      case "video":
      case "file":
      case "voice":
        flushText()
        parts.push({ type: "media", segment: seg })
        if (seg.type === "voice") {
          downgrades.push({ from: "voice", to: "file", reason: "ilink_audio_sent_as_file" })
        }
        break
    }
  }

  flushText()
  return {
    parts,
    textChunks: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    downgrades,
  }
}
