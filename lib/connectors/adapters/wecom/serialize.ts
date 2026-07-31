/**
 * WeCom outbound projection — splits a cross-platform `MessageSegment[]` into
 * the pieces the WeCom 智能机器人 protocol can carry:
 *
 *   - a single markdown body (text / markdown / code / mention / mirror text),
 *   - the interactive A2UI surfaces to map onto a `template_card`,
 *   - media segments (image / voice / video / file) that need a 3-step upload.
 *
 * Pure + synchronous so it is trivially unit-testable. The async work —
 * template-card mapping (records callback bindings) and media upload — is
 * orchestrated by `index.ts`, which consumes this split.
 */

import type { A2UIMessageSegment, MessageSegment, PlatformCard } from "@/types/connectors/segment"
import { isA2UISegment } from "@/types/connectors/segment"
import type { SegmentDowngrade } from "@/types/connectors/outbound"
import { WECOM_MARKDOWN_MAX_BYTES, type WeComTemplateCard } from "./protocol"

export interface WeComMediaSegment {
  type: "image" | "voice" | "video" | "file"
  url: string
  name?: string
  mimeType?: string
}

export interface WeComSerialized {
  /** Combined markdown body (may be empty when the reply is media/card-only). */
  markdown: string
  /** Interactive A2UI surfaces, in emission order, for template_card mapping. */
  a2uiSurfaces: A2UIMessageSegment[]
  /** Media segments needing a chunked upload before send. */
  media: WeComMediaSegment[]
  /**
   * Pass-through `template_card` payloads carried by generic card segments
   * whose `payload` is already template_card-shaped (has a string
   * `card_type`). Sent as native card frames by `index.ts`.
   */
  cards: WeComTemplateCard[]
  downgrades: SegmentDowngrade[]
}

/** Return the payload as a template card when it is template_card-shaped. */
function asWeComTemplateCard(card: PlatformCard): WeComTemplateCard | null {
  const p = card.payload
  if (p && typeof p === "object" && typeof (p as { card_type?: unknown }).card_type === "string") {
    return p as WeComTemplateCard
  }
  return null
}

/** Best-effort text alternative for an opaque (non-WeCom) card payload. */
function cardTextAlternative(card: PlatformCard): string | null {
  const p = card.payload as Record<string, unknown> | null | undefined
  if (!p || typeof p !== "object") return null
  for (const key of ["text", "content", "title"]) {
    const v = p[key]
    if (typeof v === "string" && v.trim()) return v
  }
  return null
}

/** Truncate a UTF-8 string to at most `maxBytes`, keeping whole code points. */
export function clampUtf8(input: string, maxBytes: number): string {
  const enc = new TextEncoder()
  if (enc.encode(input).length <= maxBytes) return input
  // Binary-search the longest prefix that fits.
  let lo = 0
  let hi = input.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (enc.encode(input.slice(0, mid)).length <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return input.slice(0, lo)
}

/**
 * Split `segments` into the WeCom outbound pieces. Text-bearing segments
 * concatenate into the markdown body (newline-joined); A2UI surfaces are
 * collected for template-card mapping but ALSO contribute their
 * `plainTextMirror` to the markdown so non-button surfaces degrade
 * gracefully; media segments are collected separately.
 */
export function serializeSegments(segments: MessageSegment[]): WeComSerialized {
  const lines: string[] = []
  const a2uiSurfaces: A2UIMessageSegment[] = []
  const media: WeComMediaSegment[] = []
  const cards: WeComTemplateCard[] = []
  const downgrades: SegmentDowngrade[] = []

  for (const seg of segments) {
    if (isA2UISegment(seg)) {
      a2uiSurfaces.push(seg)
      // Always include the mirror so a surface that can't map to a
      // template_card (Select, form, …) still survives as text.
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
        lines.push(`\`\`\`${seg.language ?? ""}\n${seg.code}\n\`\`\``)
        break
      case "mention":
        lines.push(`@${seg.displayName ?? seg.userId}`)
        break
      case "emoji":
        lines.push(`[${seg.code}]`)
        break
      case "reply":
        lines.push(`> ${seg.snippet}`)
        break
      case "location":
        lines.push(`📍 ${seg.name ?? `${seg.lat},${seg.lon}`}`)
        break
      case "poll":
        lines.push(`📊 ${seg.question}\n${seg.options.map((o) => `- ${o}`).join("\n")}`)
        break
      case "image":
        media.push({ type: "image", url: seg.url })
        break
      case "voice":
        media.push({ type: "voice", url: seg.url })
        break
      case "video":
        media.push({ type: "video", url: seg.url })
        break
      case "file":
        media.push({ type: "file", url: seg.url, name: seg.name, mimeType: seg.mimeType })
        break
      case "card": {
        // Template_card-shaped payloads pass through natively; other card
        // payloads degrade to their text alternative when one exists, and
        // only truly opaque cards fall back to the "[card]" marker.
        const passthrough = asWeComTemplateCard(seg.card)
        if (passthrough) {
          cards.push(passthrough)
          break
        }
        const alt = cardTextAlternative(seg.card)
        if (alt) {
          downgrades.push({ from: "card", to: "text", reason: "wecom_card_text_alternative" })
          lines.push(alt)
          break
        }
        downgrades.push({ from: "card", to: "text", reason: "wecom_no_generic_card" })
        lines.push("[card]")
        break
      }
    }
  }

  return {
    markdown: clampUtf8(lines.join("\n\n").trim(), WECOM_MARKDOWN_MAX_BYTES),
    a2uiSurfaces,
    media,
    cards,
    downgrades,
  }
}
