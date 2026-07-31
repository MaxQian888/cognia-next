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
// Rich-segment helpers (NapCat extensions, shared by v11 + v12)
// ---------------------------------------------------------------------------

/**
 * Flatten a NapCat merged-forward (`forward` / `node`) segment into readable
 * text. NapCat may inline the forwarded nodes under `data.content`
 * (`[{ type:"node", data:{ nickname, content:[…segments] } }]`); when it does
 * we render `nickname: text` lines. When the content isn't inlined (only a
 * forward `id` is present) we fall back to a generic marker — fetching the full
 * forward body needs a `get_forward_msg` round-trip, out of scope here.
 */
function summarizeForward(d: Record<string, unknown>): string {
  const content = d.content
  if (Array.isArray(content) && content.length > 0) {
    const lines: string[] = []
    for (const node of content as Array<Record<string, unknown>>) {
      const nodeData = (node.data ?? {}) as Record<string, unknown>
      const name = String(nodeData.nickname ?? nodeData.name ?? "")
      const inner = nodeData.content ?? nodeData.message
      let text = ""
      if (Array.isArray(inner)) {
        text = (inner as OneBotSegment[])
          .map((s) => (s.type === "text" ? String((s.data ?? {}).text ?? "") : `[${s.type}]`))
          .join("")
      } else if (typeof inner === "string") {
        text = inner
      }
      lines.push(name ? `${name}: ${text}` : text)
    }
    return `[合并转发]\n${lines.join("\n")}`
  }
  return "[合并转发消息]"
}

/**
 * Extract a human-readable label from a NapCat `json` card segment (share
 * cards / mini-apps). The card payload is a JSON string under `data.data`;
 * its `prompt` field is the QQ-rendered one-line summary.
 */
function summarizeJsonCard(d: Record<string, unknown>): string {
  const raw = d.data
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as { prompt?: unknown }
      if (typeof parsed.prompt === "string" && parsed.prompt) return parsed.prompt
    } catch {
      // not valid JSON — fall through to the generic marker
    }
  }
  return "[卡片消息]"
}

/**
 * Extract a human-readable label from a legacy `xml` card segment (older QQ
 * share cards, structured messages). The payload is an XML string under
 * `data.data`; prefer the `brief="…"` attribute (QQ's one-line summary),
 * then a `<title>` element, else the generic marker.
 */
function summarizeXmlCard(d: Record<string, unknown>): string {
  const raw = d.data
  if (typeof raw === "string") {
    const brief = raw.match(/brief="([^"]+)"/)?.[1]
    if (brief) return brief
    const title = raw.match(/<title[^>]*>([^<]+)<\/title>/)?.[1]
    if (title && title.trim()) return title.trim()
  }
  return "[卡片消息]"
}

/**
 * Map a QQ magic-face style segment (`dice` / `rps`) to a readable marker,
 * surfacing the rolled value when the upstream includes one (`result` on
 * NapCat, `value`/`id` on go-cqhttp).
 */
function summarizeMagicFace(label: string, d: Record<string, unknown>): string {
  const value = d.result ?? d.value ?? d.id
  return value !== undefined && value !== "" ? `[${label}:${value}]` : `[${label}]`
}

/**
 * Map a NapCat `location` segment to the structured internal `location`
 * segment (higher fidelity than a text marker; the union supports it
 * natively). `lat`/`lon`/`title` field names are shared across v11 + v12.
 */
function locationSegment(d: Record<string, unknown>): MessageSegment {
  const lat = Number(d.lat ?? 0)
  const lon = Number(d.lon ?? d.lng ?? 0)
  const name = String(d.title ?? d.content ?? "") || undefined
  return { type: "location", lat, lon, name }
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
      // `[CQ:at,qq=all]` is a mass ping (@全体成员), not a user mention. No
      // repo-wide mention-all convention exists yet (at-gate / Lark / Telegram
      // have none), so we record it with the literal userId "all" plus a
      // displayName marker for renderers — and deliberately do NOT flip
      // selfMentioned, so a group-wide ping never triggers spammy auto-replies.
      if (qq === "all") return { type: "mention", userId: "all", displayName: "@all" }
      return { type: "mention", userId: qq }
    }

    case "reply":
      // `snippet` is not on the wire — the inbound-reply enrichment step
      // (inbound-reply.ts) injects it via a best-effort get_msg round-trip.
      return {
        type: "reply",
        messageId: String(d.id ?? ""),
        snippet: typeof d.snippet === "string" ? d.snippet : "",
      }

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

    case "mface": {
      // NapCat market face (商城表情). Prefer the sticker image; fall back to
      // its text summary.
      const url = d.url ?? d.file
      if (typeof url === "string" && url) return { type: "image", url }
      return { type: "text", text: String(d.summary ?? "") || "[表情]" }
    }

    case "forward":
    case "node":
      return { type: "text", text: summarizeForward(d) }

    case "json":
      return { type: "text", text: summarizeJsonCard(d) }

    case "xml":
      return { type: "text", text: summarizeXmlCard(d) }

    case "location":
      return locationSegment(d)

    case "poke":
      return { type: "text", text: "[戳一戳]" }

    case "dice":
      return { type: "text", text: summarizeMagicFace("骰子", d) }

    case "rps":
      return { type: "text", text: summarizeMagicFace("猜拳", d) }

    case "contact":
      return { type: "text", text: "[推荐名片]" }

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

    case "mface": {
      const url = d.url ?? d.file_id
      if (typeof url === "string" && url) return { type: "image", url }
      return { type: "text", text: String(d.summary ?? "") || "[表情]" }
    }

    case "forward":
    case "node":
      return { type: "text", text: summarizeForward(d) }

    case "json":
      return { type: "text", text: summarizeJsonCard(d) }

    case "xml":
      return { type: "text", text: summarizeXmlCard(d) }

    case "location":
      return locationSegment(d)

    case "poke":
      return { type: "text", text: "[戳一戳]" }

    case "dice":
      return { type: "text", text: summarizeMagicFace("骰子", d) }

    case "rps":
      return { type: "text", text: summarizeMagicFace("猜拳", d) }

    case "contact":
      return { type: "text", text: "[推荐名片]" }

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
 * Unescape CQ-code entities per the OneBot 11 string spec
 * (message/string.md): `&#91;` → `[`, `&#93;` → `]`, `&#44;` → `,`,
 * `&amp;` → `&`. `&amp;` MUST be replaced LAST — doing it first
 * double-unescapes, e.g. a literal "&amp;#91;" (an escaped "&#91;") would
 * wrongly collapse into "[".
 */
function unescapeCq(s: string): string {
  return s
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&")
}

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
      const text = unescapeCq(token)
      if (text) segments.push({ type: "text", text })
      continue
    }

    const cqType = cqMatch[1]
    const paramStr = cqMatch[2] ?? ""
    // Parse key=value pairs. Values are CQ-escaped on the wire (an image URL
    // with query params arrives as "...?a=1&amp;b=2") — unescape them or every
    // multi-param media URL is a dead link.
    const params: Record<string, string> = {}
    for (const pair of paramStr.slice(1).split(",")) {
      const eqIdx = pair.indexOf("=")
      if (eqIdx > 0) {
        params[pair.slice(0, eqIdx)] = unescapeCq(pair.slice(eqIdx + 1))
      }
    }

    const seg = fromV11Segment({ type: cqType, data: params })
    segments.push(seg)
  }

  return segments
}
