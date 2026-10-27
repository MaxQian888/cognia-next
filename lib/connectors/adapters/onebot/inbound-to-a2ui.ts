/**
 * OneBot CQ-code segments → InboundA2UIBlock projection.
 *
 * OneBot v11 messages are arrays of segments, each with a `type` and
 * `data` payload. We map the major segment types into InboundA2UI:
 *
 *   text     → text node
 *   image    → image node
 *   at       → mention node (carries the at'd user id)
 *   reply    → reply_context node
 *   face     → text with the face id (no emoji table on the agent side)
 *   share    → card with title/content/url
 *   record   → link node (voice message — surfaced as a download link)
 *   video    → link node (with mime hint if available)
 *
 * Anything else falls through into `raw` so operators can still see the
 * payload via the renderer's `<details>` view.
 */

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import { fromOneBotSegments } from "./segments"

interface OneBotSegment {
  type?: string
  data?: Record<string, unknown>
}

function s(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : ""
}

function mapSegment(seg: OneBotSegment): InboundA2UINode | null {
  switch (seg.type) {
    case "text":
      return { kind: "text", text: s(seg.data?.text) }
    case "image": {
      // v11 carries url/file; v12 carries file_id.
      const url = s(seg.data?.url) || s(seg.data?.file) || s(seg.data?.file_id)
      if (!url) return null
      return { kind: "image", url, alt: s(seg.data?.summary) || undefined }
    }
    // v11 "at" (qq=…) and v12 "mention" (user_id=…) are the same concept.
    case "at":
    case "mention":
      return {
        kind: "mention",
        handle: s(seg.data?.qq) || s(seg.data?.user_id),
        resolved: s(seg.data?.name) || undefined,
      }
    case "mention_all":
      return { kind: "mention", handle: "all" }
    case "reply":
      return {
        kind: "reply_context",
        replyToMessageId: s(seg.data?.message_id) || s(seg.data?.id),
      }
    case "face":
      return { kind: "text", text: `[face:${s(seg.data?.id)}]`, emphasis: "muted" }
    case "share":
      return {
        kind: "card",
        title: s(seg.data?.title),
        subtitle: s(seg.data?.content) || undefined,
        children: [
          ...(s(seg.data?.content) ? [{ kind: "text" as const, text: s(seg.data?.content) }] : []),
          ...(s(seg.data?.url)
            ? [{ kind: "link" as const, href: s(seg.data?.url), label: s(seg.data?.url) }]
            : []),
        ],
      }
    // v11 "record" and v12 "voice"; v12 carries file_id instead of url/file.
    case "record":
    case "voice":
    case "audio":
      return {
        kind: "link",
        href:
          s(seg.data?.url) ||
          (seg.type === "record"
            ? `cq-record:${s(seg.data?.file)}`
            : s(seg.data?.file_id) || s(seg.data?.file)),
        label: "Voice message",
      }
    case "video":
      return {
        kind: "link",
        href: s(seg.data?.url) || `cq-video:${s(seg.data?.file) || s(seg.data?.file_id)}`,
        label: "Video",
      }
    case "file":
      return {
        kind: "link",
        href: s(seg.data?.url) || s(seg.data?.file_id) || s(seg.data?.file),
        label: s(seg.data?.name) || "Attachment",
      }
    case "location": {
      const [location] = fromOneBotSegments([{ type: "location", data: seg.data ?? {} }], "v12")
      if (
        !location ||
        location.type !== "location" ||
        !Number.isFinite(location.lat) ||
        !Number.isFinite(location.lon)
      )
        return null
      return {
        kind: "text",
        text: `${location.name ? `${location.name} ` : ""}(${location.lat}, ${location.lon})`,
      }
    }
    default:
      return null
  }
}

export function onebotInboundToA2UI(payload: {
  message?: OneBotSegment[] | string
}): InboundA2UIBlock | null {
  if (!payload || !payload.message) return null
  // A string-form message is CQ-code text the parser already decodes into
  // segments (entities, @-mentions, images); projecting the raw string would
  // show `[CQ:…]` codes and `&amp;` beside the decoded parts.
  if (typeof payload.message === "string") return null
  if (!Array.isArray(payload.message)) return null
  const body: InboundA2UINode[] = []
  for (const seg of payload.message) {
    if (
      !seg ||
      typeof seg !== "object" ||
      !seg.data ||
      typeof seg.data !== "object" ||
      Array.isArray(seg.data)
    )
      continue
    const node = mapSegment(seg)
    if (node) body.push(node)
  }
  if (body.length === 0) return null
  return { v: 1, source: "onebot", body, raw: payload }
}
