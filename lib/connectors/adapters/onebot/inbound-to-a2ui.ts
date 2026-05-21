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

interface OneBotSegment {
  type?: string
  data?: Record<string, unknown>
}

function s(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function mapSegment(seg: OneBotSegment): InboundA2UINode | null {
  switch (seg.type) {
    case "text":
      return { kind: "text", text: s(seg.data?.text) }
    case "image": {
      const url = s(seg.data?.url) || s(seg.data?.file)
      if (!url) return null
      return { kind: "image", url, alt: s(seg.data?.summary) || undefined }
    }
    case "at":
      return {
        kind: "mention",
        handle: s(seg.data?.qq),
        resolved: s(seg.data?.name) || undefined,
      }
    case "reply":
      return {
        kind: "reply_context",
        replyToMessageId: s(seg.data?.id),
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
    case "record":
      return {
        kind: "link",
        href: s(seg.data?.url) || `cq-record:${s(seg.data?.file)}`,
        label: "Voice message",
      }
    case "video":
      return {
        kind: "link",
        href: s(seg.data?.url) || `cq-video:${s(seg.data?.file)}`,
        label: "Video",
      }
    default:
      return null
  }
}

export function onebotInboundToA2UI(payload: {
  message?: OneBotSegment[] | string
}): InboundA2UIBlock | null {
  if (!payload.message) return null
  if (typeof payload.message === "string") {
    if (!payload.message.trim()) return null
    return {
      v: 1,
      source: "onebot",
      body: [{ kind: "text", text: payload.message }],
    }
  }
  const body: InboundA2UINode[] = []
  for (const seg of payload.message) {
    const node = mapSegment(seg)
    if (node) body.push(node)
  }
  if (body.length === 0) return null
  return { v: 1, source: "onebot", body, raw: payload }
}
