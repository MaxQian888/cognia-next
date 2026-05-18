/**
 * Reverse of `a2ui-to-segments.ts`: project inbound platform-rich content
 * (Slack rich_text blocks / Lark interactive cards / Telegram caption +
 * inline keyboard / Discord embed + components) into an A2UI Surface.
 *
 * Lives here rather than in each adapter because the destination shape
 * (A2UISegmentContent) is the same regardless of platform — only the
 * source shape differs, and we want one place to maintain the canonical
 * "this is what A2UI looks like" projection.
 *
 * Each adapter's `parse.ts` calls `segmentsToA2UI` after building its
 * MessageSegment[] when the inbound payload contained platform-rich
 * content; the returned surface is attached as an extra `a2ui` segment
 * so the bus + renderer treat the inbound message identically to one
 * the assistant would have generated.
 */

import type {
  A2UIMessageSegment,
  A2UISegmentContent,
  MessageSegment,
} from "@/types/connectors/segment"
import type { PlatformKind } from "@/types/connectors/platform-kind"

let surfaceCounter = 0

function nextSurfaceId(platform: PlatformKind, adapterId: string, messageId: string): string {
  surfaceCounter += 1
  return `inbound:${platform}:${adapterId}:${messageId}:${surfaceCounter}`
}

/**
 * Lift a flat MessageSegment[] into an A2UI Surface. Use this from a
 * platform parser when the inbound message carried structured rich
 * content that should be re-rendered to the user as an A2UI surface
 * (Lark interactive card, Slack section + actions, etc.).
 *
 * The output surface has:
 *
 *   - `rootId = "root"`
 *   - one `Column` component holding the projected children.
 *   - one child per segment, mapped per the segment-kind switch below.
 *
 * Segments that don't map cleanly (e.g., raw mentions, reactions)
 * collapse into a plain Text node so the renderer never sees a dangling
 * component reference.
 */
export function segmentsToA2UI(
  platform: PlatformKind,
  adapterId: string,
  messageId: string,
  segments: MessageSegment[]
): A2UIMessageSegment | null {
  if (segments.length === 0) return null

  const surfaceId = nextSurfaceId(platform, adapterId, messageId)
  const components: Record<string, Record<string, unknown>> = {}
  const childIds: string[] = []
  const textParts: string[] = []
  let counter = 0
  const nextId = (prefix: string): string => {
    counter += 1
    return `${prefix}-${counter}`
  }

  for (const segment of segments) {
    switch (segment.type) {
      case "text": {
        const id = nextId("text")
        components[id] = { id, component: "Text", text: segment.text, variant: "body" }
        childIds.push(id)
        textParts.push(segment.text)
        break
      }
      case "markdown": {
        const id = nextId("text")
        components[id] = { id, component: "Text", text: segment.md, variant: "body" }
        childIds.push(id)
        textParts.push(segment.md)
        break
      }
      case "image": {
        const id = nextId("img")
        components[id] = {
          id,
          component: "Image",
          src: segment.url,
          alt: segment.alt,
          width: segment.width,
          height: segment.height,
        }
        childIds.push(id)
        if (segment.alt) textParts.push(`[${segment.alt}]`)
        break
      }
      case "card": {
        // The inbound `card` segment is opaque (PlatformCard). We expose
        // it as a generic Card whose content is the textual summary —
        // the renderer can opt-in to richer projection later if it
        // recognises `card.kind`.
        const id = nextId("card")
        components[id] = {
          id,
          component: "Card",
          title: typeof segment.card.kind === "string" ? segment.card.kind : "Card",
          children: [],
        }
        childIds.push(id)
        textParts.push(`[card:${segment.card.kind}]`)
        break
      }
      case "video":
      case "voice":
      case "file": {
        const id = nextId("link")
        const label =
          segment.type === "file"
            ? `[file] ${segment.name}`
            : segment.type === "voice"
              ? "[voice]"
              : "[video]"
        components[id] = { id, component: "Link", text: label, href: segment.url }
        childIds.push(id)
        textParts.push(label)
        break
      }
      case "location": {
        const id = nextId("text")
        const label = segment.name ?? `${segment.lat}, ${segment.lon}`
        components[id] = { id, component: "Text", text: `📍 ${label}`, variant: "body" }
        childIds.push(id)
        textParts.push(`[location:${label}]`)
        break
      }
      case "a2ui": {
        // An inbound segment that already carries a structured surface —
        // hand it back unchanged (no point re-wrapping).
        return segment
      }
      // mention / emoji / code / reply / poll are folded into text — they
      // don't have meaningful A2UI structural equivalents.
      default:
        break
    }
  }

  if (childIds.length === 0) return null

  const rootId = "root"
  components[rootId] = { id: rootId, component: "Column", children: childIds }

  const content: A2UISegmentContent = {
    components,
    dataModel: {},
    rootId,
    surfaceType: "inline",
  }

  return {
    type: "a2ui",
    surfaceId,
    content,
    plainTextMirror: textParts.filter(Boolean).join("\n"),
  }
}
