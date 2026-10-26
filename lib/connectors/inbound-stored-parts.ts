import type { StoredMessage } from "@cognia/agent-config-types"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

/**
 * The stored `parts` for an inbound IM message: text and Markdown verbatim,
 * media as `[image: …]` / `[file: …]` markers, anything else as the event's
 * plain text. Shared by the create path (`insertInboundMessage`) and the edit
 * path (`bus.applyMessageEdit`) so an edited message is stored exactly as a
 * new one would be.
 *
 * Media stays a text marker on purpose: these parts are chat history that
 * later turns replay to the model, and whether an inbound image's bytes may
 * reach a cloud model is decided per turn by the bus (`mediaModelPolicy`),
 * not by what was once stored.
 */
export function inboundEventToStoredParts(
  event: Pick<NormalizedInboundEvent, "segments" | "plainText">
): StoredMessage["parts"] {
  const parts: StoredMessage["parts"] = event.segments
    .map((seg) => {
      if (seg.type === "text" || seg.type === "markdown") {
        return {
          type: "text" as const,
          text: seg.type === "text" ? seg.text : seg.md,
        }
      }
      if (seg.type === "image") {
        return { type: "text" as const, text: `[image: ${seg.url}]` }
      }
      if (seg.type === "file") {
        return { type: "text" as const, text: `[file: ${seg.name}]` }
      }
      // Other segment types degrade to a text placeholder.
      return { type: "text" as const, text: event.plainText }
    })
    .filter((_, i, arr) => {
      // De-duplicate fallback entries: only keep one text part when all
      // segments collapsed to the same plainText.
      if (i === 0) return true
      const prev = arr[i - 1]
      const curr = arr[i]
      if (prev.type === "text" && curr.type === "text" && prev.text === curr.text) return false
      return true
    })
  // If the segment list was empty, fall back to plainText.
  return parts.length > 0 ? parts : [{ type: "text", text: event.plainText }]
}
