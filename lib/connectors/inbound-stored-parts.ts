import type { StoredMessage } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"

/**
 * Streaming snapshots own the assistant, while the connector owns its stored
 * rows. Keep the latest projected connector rows through an older stream frame
 * without changing explicit transcript replacement or deletion semantics.
 */
export function mergeInboundMessagesForStream(
  messages: UIMessage[],
  projectedMessages: readonly UIMessage[]
): UIMessage[] {
  const inbound = projectedMessages.filter((message) => {
    const platform = (message.metadata as { platformMessage?: unknown } | undefined)
      ?.platformMessage
    return platform !== null && typeof platform === "object"
  })
  if (inbound.length === 0) return messages
  const inboundById = new Map(inbound.map((message) => [message.id, message]))
  const ids = new Set(messages.map((message) => message.id))
  let changed = false
  const next = messages.map((message) => {
    const projected = inboundById.get(message.id)
    if (!projected || projected === message) return message
    changed = true
    return projected
  })
  const createdAt = (message: UIMessage): number | undefined => {
    const value = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }
  const missing = inbound.filter((message) => !ids.has(message.id))
  missing.sort((a, b) => (createdAt(a) ?? Infinity) - (createdAt(b) ?? Infinity))
  for (const message of missing) {
    if (ids.has(message.id)) continue
    const at = createdAt(message)
    const index =
      at === undefined
        ? -1
        : next.findIndex((candidate) => {
            const candidateAt = createdAt(candidate)
            return candidateAt !== undefined && candidateAt > at
          })
    next.splice(index < 0 ? next.length : index, 0, message)
    ids.add(message.id)
    changed = true
  }
  return changed ? next : messages
}

/** Recovered source content is canonical history, never a new media grant. */
export function inboundEventFromStoredMessage(
  event: NormalizedInboundEvent,
  stored: StoredMessage
): NormalizedInboundEvent {
  const continuation = event.channelData?.recoveryIntent === "continue_safely"
  const parts = inboundPartsForReplay(stored.parts)
  const segments: MessageSegment[] = continuation
    ? [{ type: "text", text: stripInboundDisplayMarkers(event.plainText) }]
    : parts.flatMap((part) =>
        part.type === "text" ? [{ type: "text" as const, text: part.text }] : []
      )
  return {
    ...event,
    segments,
    plainText: segmentsToPlainText(segments),
    raw: undefined,
    mediaModelPolicy: "local_extract_only",
  }
}

/** Resolvers may replace a platform reference with local bytes for display. */
export function inboundImageMarker(seg: Extract<MessageSegment, { type: "image" }>): string {
  const reference = [seg.url, seg.rawUrl].find(
    (url) => typeof url === "string" && url.length > 0 && !/^\s*(?:data|blob):/i.test(url)
  )
  return reference ? `[image: ${reference}]` : "[image]"
}

/** Also handles quoted and truncated legacy markers in reply/context previews. */
export function stripInboundDisplayMarkers(text: string): string {
  return text.replace(/\[image:\s*(?:data|blob):[^\]]*(?:\]|$)/gi, "[image]")
}

/** Older resolvers persisted data URLs inside text markers; never replay those bytes. */
export function inboundPartsForReplay(parts: StoredMessage["parts"]): StoredMessage["parts"] {
  if (!Array.isArray(parts)) return []
  return parts.flatMap((part): StoredMessage["parts"] => {
    if (!part || typeof part !== "object" || typeof part.type !== "string") return []
    // Imported/legacy connector rows may contain binary parts from an older
    // resolver. Historical display data never grants a later model turn media.
    if (part.type === "file" || (part.type as string) === "image") {
      const media = part as { mediaType?: unknown; filename?: unknown }
      const image =
        (part.type as string) === "image" ||
        (typeof media.mediaType === "string" && media.mediaType.startsWith("image/"))
      return [
        {
          type: "text",
          text: image
            ? "[image]"
            : typeof media.filename === "string"
              ? `[file: ${media.filename}]`
              : "[file]",
        },
      ]
    }
    if (part.type !== "text") return [part]
    if (typeof part.text !== "string") return []
    const text = stripInboundDisplayMarkers(part.text)
    return [text === part.text ? part : { ...part, text }]
  })
}

/**
 * The stored `parts` for an inbound IM message: text and Markdown verbatim,
 * media as `[image: …]` / `[file: …]` markers, other segments as their own
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
  const parts: StoredMessage["parts"] = (
    Array.isArray(event.segments) ? event.segments : []
  ).flatMap((seg): StoredMessage["parts"] => {
    if (!seg || typeof seg !== "object") return []
    if (seg.type === "text" || seg.type === "markdown") {
      const text = seg.type === "text" ? seg.text : seg.md
      return typeof text === "string"
        ? [
            {
              type: "text" as const,
              text,
            },
          ]
        : []
    }
    if (seg.type === "image") {
      return [{ type: "text" as const, text: inboundImageMarker(seg) }]
    }
    if (seg.type === "file") {
      return [
        {
          type: "text" as const,
          text: typeof seg.name === "string" ? `[file: ${seg.name}]` : "[file]",
        },
      ]
    }
    // Project this occurrence only. Reusing event.plainText duplicates the
    // full body for every reply, mention or audio/video attachment.
    try {
      return [
        {
          type: "text" as const,
          text: stripInboundDisplayMarkers(segmentsToPlainText([seg]).trim()),
        },
      ]
    } catch {
      return []
    }
  })
  // If the segment list was empty, fall back to plainText.
  return parts.length > 0
    ? parts
    : [
        {
          type: "text",
          text:
            typeof event.plainText === "string" ? stripInboundDisplayMarkers(event.plainText) : "",
        },
      ]
}
