/**
 * Matrix timeline event → InboundA2UIBlock projection.
 *
 * Matrix messages carry a plain `body`, optional media (`m.image` / `m.file` /
 * `m.audio` / `m.video`, each with an `mxc://` url), a reply relation
 * (`m.in_reply_to`), and `m.mentions`. We surface these as the inbox's
 * structured view so an inbound image renders as an image and a reply shows
 * its quote — the flat message parts only carry text placeholders.
 *
 * The `formatted_body` HTML is intentionally NOT parsed (it would leak raw
 * tags into a text node); the plain `body` is used and the full event is
 * attached to `raw` for the debug `<details>` view. Mirrors the Telegram
 * mapper: `m.image` → image node, other media → link nodes.
 */

import type { MessageSegment } from "@/types/connectors/segment"
import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import type { MatrixTimelineEvent, MatrixEventContent } from "./parse"
import { matrixMediaCaption, stripReplyFallback } from "./parse"

export interface MatrixInboundToA2UIOptions {
  /**
   * The normalized event's segments. The parser resolved each `mxc://` URI
   * into a homeserver download URL (`url`, with the original kept in
   * `rawUrl`), and the media resolver inlines small images as `dataBase64` —
   * both are renderable where the raw `mxc://` URI is not.
   */
  segments?: MessageSegment[]
}

/** `@local:server` → `local` for a friendlier mention chip. */
function localpart(userId: string): string {
  const m = /^@([^:]+):/.exec(userId)
  return m ? m[1] : userId
}

type MediaSegment = Extract<MessageSegment, { type: "image" | "video" | "voice" | "file" }>

function findMediaSegment(mxcUrl: string, segments?: MessageSegment[]): MediaSegment | undefined {
  return segments?.find(
    (s): s is MediaSegment =>
      (s.type === "image" || s.type === "video" || s.type === "voice" || s.type === "file") &&
      (s.rawUrl === mxcUrl || s.url === mxcUrl)
  )
}

function mediaNode(
  content: MatrixEventContent,
  segments?: MessageSegment[]
): InboundA2UINode | null {
  const rawUrl = content.file?.url ?? content.url
  if (typeof rawUrl !== "string" || !rawUrl) return null
  const seg = findMediaSegment(rawUrl, segments)
  // Only shared enrichment allocates bytes against the cumulative budget.
  // A mapper URL must remain a reference even for a cached 6 MiB image.
  const url = seg?.url && !/^(?:data|blob):/i.test(seg.url) ? seg.url : rawUrl
  switch (content.msgtype) {
    case "m.image":
      return {
        kind: "image",
        url,
        alt: content.body,
        width: content.info?.w,
        height: content.info?.h,
      }
    case "m.video":
      return { kind: "link", href: url, label: content.filename || content.body || "Video" }
    case "m.audio":
      return { kind: "link", href: url, label: content.filename || content.body || "Voice message" }
    case "m.file":
      return { kind: "link", href: url, label: content.filename || content.body || "Attachment" }
    default:
      return null
  }
}

export function matrixInboundToA2UI(
  ev: MatrixTimelineEvent,
  options: MatrixInboundToA2UIOptions = {}
): InboundA2UIBlock | null {
  if (!ev || typeof ev !== "object" || !ev.content) return null

  // For `m.replace` edits the renderable content lives in `m.new_content`;
  // the original event's reply relation cannot be replaced by the edit.
  const rel = ev.content["m.relates_to"]
  const isEdit = rel?.rel_type === "m.replace" && rel.event_id !== undefined
  const content = isEdit ? (ev.content["m.new_content"] ?? ev.content) : ev.content

  const body: InboundA2UINode[] = []

  const inReplyTo = isEdit ? undefined : rel?.["m.in_reply_to"]?.event_id
  if (inReplyTo) {
    body.push({ kind: "reply_context", replyToMessageId: inReplyTo })
  }

  const media = mediaNode(content, options.segments)
  if (media) {
    body.push(media)
    const caption = matrixMediaCaption(content)
    if (caption) body.push({ kind: "text", text: caption })
  } else {
    const raw = typeof content.body === "string" ? content.body : ""
    const text = inReplyTo ? stripReplyFallback(raw) : raw
    if (text) body.push({ kind: "text", text })
  }

  const users = content["m.mentions"]?.user_ids
  for (const uid of Array.isArray(users) ? users : []) {
    if (typeof uid === "string" && uid)
      body.push({ kind: "mention", handle: uid, resolved: localpart(uid) })
  }

  if (body.length === 0) return null
  return { v: 1, source: "matrix", body, raw: ev }
}
