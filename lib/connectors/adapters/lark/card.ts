/**
 * Lark card serialiser — Task 82.
 *
 * Converts MessageSegments to Lark API request body shapes
 * (im_v1 cards 2.0 / text / post / image).
 *
 * Lark markdown special chars that need escaping:
 *   \  →  \\
 *   @  →  \@  (would otherwise trigger a mention)
 *
 * Lark supports: **bold**, *italic*, [link](url), line breaks (\n).
 */

import type { MessageSegment } from "@/types/connectors/segment"

// ---------------------------------------------------------------------------
// Lark message body shape (im/v1/messages)
// ---------------------------------------------------------------------------

export type LarkMsgType = "text" | "interactive" | "image" | "post"

export interface LarkMessageBody {
  msg_type: LarkMsgType
  /** JSON-stringified content per msg_type. */
  content: string
}

// ---------------------------------------------------------------------------
// Markdown escape
// ---------------------------------------------------------------------------

/**
 * Escape characters that Lark markdown treats specially.
 *
 * Lark uses @ for mentions and \ as an escape character.
 * We escape both so that user text containing these is rendered literally.
 */
export function escapeLarkMarkdown(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/@/g, "\\@")
}

// ---------------------------------------------------------------------------
// Segment → Lark body
// ---------------------------------------------------------------------------

/**
 * Render a single MessageSegment as a LarkMessageBody.
 *
 * Returns null for segment types that are not representable in Phase 1
 * (voice, video, location, poll, emoji, reply — all dropped).
 */
export function segmentToLarkBody(seg: MessageSegment): LarkMessageBody | null {
  switch (seg.type) {
    case "text":
      return {
        msg_type: "text",
        content: JSON.stringify({ text: seg.text }),
      }

    case "markdown": {
      // Lark "post" (rich text) can embed markdown; for Phase 1 we use the
      // interactive card's markdown element.
      const escaped = escapeLarkMarkdown(seg.md)
      return {
        msg_type: "interactive",
        content: JSON.stringify({
          elements: [
            {
              tag: "div",
              text: { content: escaped, tag: "lark_md" },
            },
          ],
        }),
      }
    }

    case "image":
      // image_key-based card; URL-uploaded images are Phase 2.
      // If the url looks like an image_key (no scheme prefix), use directly.
      // Otherwise fall back to a text message with the URL.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "image",
          content: JSON.stringify({ image_key: seg.url }),
        }
      }
      // URL-form image — render as text link in Phase 1
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[image](${seg.url})` }),
      }

    case "code": {
      const lang = seg.language ?? ""
      const block = lang ? `\`\`\`${lang}\n${seg.code}\n\`\`\`` : `\`\`\`\n${seg.code}\n\`\`\``
      return {
        msg_type: "text",
        content: JSON.stringify({ text: block }),
      }
    }

    case "mention":
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `<at open_id="${seg.userId}"></at>` }),
      }

    case "card":
      // Phase 1: opaque card → plain text placeholder
      return {
        msg_type: "text",
        content: JSON.stringify({ text: "[card]" }),
      }

    case "file":
      // Phase 1: link in text
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[${seg.name}](${seg.url})` }),
      }

    case "reply":
    case "emoji":
    case "voice":
    case "video":
    case "location":
    case "poll":
      return null

    default:
      return null
  }
}

/**
 * Convert a MessageSegment[] to a single LarkMessageBody.
 *
 * For multi-segment payloads we combine them into a single text/post body.
 * Segments that have no Lark representation are silently dropped.
 */
export function segmentsToLarkBody(segments: MessageSegment[]): LarkMessageBody {
  if (segments.length === 1) {
    const body = segmentToLarkBody(segments[0])
    if (body) return body
  }

  // Multi-segment or fallback: combine into a single text message where possible
  const textParts: string[] = []
  for (const seg of segments) {
    const body = segmentToLarkBody(seg)
    if (!body) continue

    if (body.msg_type === "text") {
      const parsed = JSON.parse(body.content) as { text?: string }
      if (parsed.text) textParts.push(parsed.text)
    } else {
      // For non-text types in a multi-segment, fall back to a plain label
      textParts.push(`[${seg.type}]`)
    }
  }

  const combined = textParts.join("\n")
  return {
    msg_type: "text",
    content: JSON.stringify({ text: combined || "[empty]" }),
  }
}
