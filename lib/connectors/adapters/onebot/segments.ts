/**
 * OneBot v11 / v12 ↔ MessageSegment mapping.
 *
 * OneBot v11 messages arrive as an array of `{type, data}` objects OR as a
 * CQ-code string like "[CQ:at,qq=123] hello".
 * OneBot v12 uses the same array format but with different field names inside
 * `data` (e.g. `user_id` instead of `qq` for at-segments).
 *
 * Lossy on unknown segment types: emits a `text` segment with a placeholder.
 */

import type { MessageSegment } from "@/types/connectors/segment"

export interface OneBotSegment {
  type: string
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// fromOneBotSegments — platform → internal
// ---------------------------------------------------------------------------

function fromV11Segment(seg: OneBotSegment): MessageSegment {
  const d = seg.data
  switch (seg.type) {
    case "text":
      return { type: "text", text: String(d.text ?? "") }

    case "image":
      return { type: "image", url: String(d.url ?? d.file ?? "") }

    case "at": {
      const qq = String(d.qq ?? "")
      return { type: "mention", userId: qq }
    }

    case "reply":
      return { type: "reply", messageId: String(d.id ?? ""), snippet: "" }

    case "face":
      return { type: "emoji", code: String(d.id ?? "") }

    case "record":
      return { type: "voice", url: String(d.url ?? d.file ?? "") }

    case "video":
      return { type: "video", url: String(d.url ?? d.file ?? "") }

    case "file":
      return {
        type: "file",
        url: String(d.url ?? d.file ?? ""),
        name: String(d.name ?? "file"),
        mimeType: "application/octet-stream",
        sizeBytes: Number(d.size ?? 0),
      }

    default:
      return { type: "text", text: `[unsupported:${seg.type}]` }
  }
}

function fromV12Segment(seg: OneBotSegment): MessageSegment {
  const d = seg.data
  switch (seg.type) {
    case "text":
      return { type: "text", text: String(d.text ?? "") }

    case "image":
      return { type: "image", url: String(d.file_id ?? d.url ?? "") }

    case "mention": {
      // v12 uses "mention" type with user_id field
      const userId = String(d.user_id ?? "")
      return { type: "mention", userId }
    }

    case "reply":
      return { type: "reply", messageId: String(d.message_id ?? ""), snippet: "" }

    case "face":
      return { type: "emoji", code: String(d.id ?? "") }

    case "voice":
      return { type: "voice", url: String(d.file_id ?? d.url ?? "") }

    case "video":
      return { type: "video", url: String(d.file_id ?? d.url ?? "") }

    case "file":
      return {
        type: "file",
        url: String(d.file_id ?? d.url ?? ""),
        name: String(d.name ?? "file"),
        mimeType: "application/octet-stream",
        sizeBytes: Number(d.size ?? 0),
      }

    default:
      return { type: "text", text: `[unsupported:${seg.type}]` }
  }
}

/**
 * Convert a OneBot segment array into internal MessageSegment[].
 */
export function fromOneBotSegments(
  segments: OneBotSegment[],
  variant: "v11" | "v12"
): MessageSegment[] {
  return segments.map((seg) => (variant === "v11" ? fromV11Segment(seg) : fromV12Segment(seg)))
}

// ---------------------------------------------------------------------------
// toOneBotSegments — internal → platform
// ---------------------------------------------------------------------------

function toV11Segment(seg: MessageSegment): OneBotSegment | null {
  switch (seg.type) {
    case "text":
      return { type: "text", data: { text: seg.text } }

    case "markdown":
      return { type: "text", data: { text: seg.md } }

    case "image":
      return { type: "image", data: { file: seg.url } }

    case "mention":
      return { type: "at", data: { qq: seg.userId } }

    case "reply":
      return { type: "reply", data: { id: seg.messageId } }

    case "emoji":
      return { type: "face", data: { id: seg.code } }

    case "voice":
      return { type: "record", data: { file: seg.url } }

    case "video":
      return { type: "video", data: { file: seg.url } }

    case "file":
      return { type: "file", data: { file: seg.url, name: seg.name } }

    default:
      return null
  }
}

function toV12Segment(seg: MessageSegment): OneBotSegment | null {
  switch (seg.type) {
    case "text":
      return { type: "text", data: { text: seg.text } }

    case "markdown":
      return { type: "text", data: { text: seg.md } }

    case "image":
      return { type: "image", data: { file_id: seg.url } }

    case "mention":
      return { type: "mention", data: { user_id: seg.userId } }

    case "reply":
      return { type: "reply", data: { message_id: seg.messageId } }

    case "emoji":
      return { type: "face", data: { id: seg.code } }

    case "voice":
      return { type: "voice", data: { file_id: seg.url } }

    case "video":
      return { type: "video", data: { file_id: seg.url } }

    case "file":
      return { type: "file", data: { file_id: seg.url, name: seg.name } }

    default:
      return null
  }
}

/**
 * Convert internal MessageSegment[] into OneBot platform segments.
 * Segments with no mapping are silently dropped.
 */
export function toOneBotSegments(
  segments: MessageSegment[],
  variant: "v11" | "v12"
): OneBotSegment[] {
  const out: OneBotSegment[] = []
  for (const seg of segments) {
    const converted = variant === "v11" ? toV11Segment(seg) : toV12Segment(seg)
    if (converted !== null) out.push(converted)
  }
  return out
}

// ---------------------------------------------------------------------------
// parseCqCodeString — CQ-code string → MessageSegment[] (v11 only)
// ---------------------------------------------------------------------------

/**
 * Parse a OneBot v11 CQ-code string into MessageSegment[].
 *
 * A CQ-code string mixes plain text with segments like `[CQ:at,qq=123]`.
 * Everything outside a `[CQ:...]` block is treated as plain text.
 */
export function parseCqCodeString(raw: string, _variant: "v11"): MessageSegment[] {
  const segments: MessageSegment[] = []
  // Split on CQ-code blocks, preserving them in the token array
  const tokens = raw.split(/(\[CQ:[^\]]+\])/g)

  for (const token of tokens) {
    if (!token) continue

    const cqMatch = token.match(/^\[CQ:([^,\]]+)(,[^\]]*)?\]$/)
    if (!cqMatch) {
      // Plain text — unescape CQ special chars
      const text = token
        .replace(/&amp;/g, "&")
        .replace(/&#91;/g, "[")
        .replace(/&#93;/g, "]")
        .replace(/&#44;/g, ",")
      if (text) segments.push({ type: "text", text })
      continue
    }

    const cqType = cqMatch[1]
    const paramStr = cqMatch[2] ?? ""
    // Parse key=value pairs
    const params: Record<string, string> = {}
    for (const pair of paramStr.slice(1).split(",")) {
      const eqIdx = pair.indexOf("=")
      if (eqIdx > 0) {
        params[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1)
      }
    }

    const seg = fromV11Segment({ type: cqType, data: params })
    segments.push(seg)
  }

  return segments
}
