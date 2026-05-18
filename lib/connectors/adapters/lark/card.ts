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

export type LarkMsgType = "text" | "interactive" | "image" | "post" | "audio" | "media" | "file"

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
 * Voice/video/file/image segments must already carry a Lark-resolved key
 * (no `://` in the URL) — `resolveLarkMediaKeys` in `upload.ts` performs
 * the upload pre-pass. Segments whose URL is still a remote URL fall back
 * to a text-link rendering so the message is never silently dropped.
 *
 * `reply`, `emoji`, `location`, `poll` have no native Lark representation
 * and return null (the multi-segment combiner emits a `[type]` placeholder).
 */
export function segmentToLarkBody(seg: MessageSegment): LarkMessageBody | null {
  switch (seg.type) {
    case "text":
      return {
        msg_type: "text",
        content: JSON.stringify({ text: seg.text }),
      }

    case "markdown": {
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
      // image_key body when the upload pre-pass has resolved the key;
      // otherwise fall back to a text-link rendering.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "image",
          content: JSON.stringify({ image_key: seg.url }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[image](${seg.url})` }),
      }

    case "voice":
      // Lark requires opus voice via msg_type=audio + file_key. The upload
      // pre-pass resolves the key; bare URLs degrade to a text-link.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "audio",
          content: JSON.stringify({ file_key: seg.url }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[voice](${seg.url})` }),
      }

    case "video":
      // msg_type=media for short-video file_keys. Bare URLs degrade to text.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "media",
          content: JSON.stringify({ file_key: seg.url }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[video](${seg.url})` }),
      }

    case "file":
      // msg_type=file requires the uploaded file_key + file_name; URLs
      // degrade to a markdown-style link in text.
      if (!seg.url.includes("://")) {
        return {
          msg_type: "file",
          content: JSON.stringify({ file_key: seg.url, file_name: seg.name }),
        }
      }
      return {
        msg_type: "text",
        content: JSON.stringify({ text: `[${seg.name}](${seg.url})` }),
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

    case "reply":
    case "emoji":
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
