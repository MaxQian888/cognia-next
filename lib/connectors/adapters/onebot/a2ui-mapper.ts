/**
 * OneBot A2UI mapper (G3.5).
 *
 * OneBot v11 / v12 protocols do not define interactive components —
 * there's no native equivalent for Button / Select / Form / Card. The
 * mapper therefore renders only the surface's text body and image
 * components, falling back to `plainTextMirror` for everything else.
 *
 * The output is a plain `MessageSegment[]` that the existing OneBot
 * serializer projects into v11 CQ codes or v12 message segments via
 * `segmentsToOneBotPayload`.
 */

import type { A2UISegmentContent, MessageSegment } from "@/types/connectors/segment"
import { walkA2UISurface, type A2UIWalkNode } from "@/lib/connectors/adapters/_shared/a2ui-mapper"

/**
 * Produce the OneBot-native projection of an A2UI surface. Walks the
 * surface tree, emitting text segments for Text/Card-title/Alert/Link
 * and image segments for Image. All interactive components collapse
 * into a leading "actions list" text segment built from
 * `plainTextMirror`.
 */
export function buildOneBotA2UISegments(
  surface: A2UISegmentContent,
  plainTextMirror: string
): MessageSegment[] {
  const segments: MessageSegment[] = []
  const lines: string[] = []
  let sawInteractive = false

  walkA2UISurface(surface, (node: A2UIWalkNode) => {
    switch (node.component) {
      case "Card": {
        const title = stringValue(node.raw.title)
        if (title) lines.push(`【${title}】`)
        break
      }
      case "Alert": {
        const title = stringValue(node.raw.title)
        const text = stringValue(node.raw.text)
        if (title || text) {
          lines.push(`⚠️ ${title || ""}${title && text ? ": " : ""}${text || ""}`)
        }
        break
      }
      case "Text": {
        const text = stringValue(node.raw.text)
        if (text) lines.push(text)
        break
      }
      case "Link": {
        const text = stringValue(node.raw.text) || stringValue(node.raw.href)
        const href = stringValue(node.raw.href)
        if (!href) break
        lines.push(text === href ? href : `${text} (${href})`)
        break
      }
      case "Divider":
        lines.push("———")
        break
      case "Image": {
        const url = stringValue(node.raw.src) || stringValue(node.raw.url)
        if (!url) break
        // Flush text-so-far before the image so message ordering matches
        // the assistant's layout.
        if (lines.length > 0) {
          segments.push({ type: "text", text: lines.join("\n") })
          lines.length = 0
        }
        segments.push({
          type: "image",
          url,
          alt: stringValue(node.raw.alt) || undefined,
        })
        break
      }
      case "Button":
      case "Select":
      case "RadioGroup":
      case "Checkbox":
      case "TextField":
      case "TextArea":
      case "DatePicker":
      case "TimePicker":
      case "Slider":
        sawInteractive = true
        break
      default:
        break
    }
  })

  // Flush remaining text.
  if (lines.length > 0) {
    segments.push({ type: "text", text: lines.join("\n") })
  }

  // When the surface contained interactive components OneBot can't
  // render, append the text mirror so the user sees the "menu" that
  // would have been buttons.
  if (sawInteractive && plainTextMirror) {
    segments.push({ type: "text", text: `\n— Available actions —\n${plainTextMirror}` })
  }

  // If the surface produced nothing visible, fall back to the mirror so
  // the message is never silently empty.
  if (segments.length === 0) {
    segments.push({ type: "text", text: plainTextMirror || "[empty]" })
  }

  return segments
}

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}
