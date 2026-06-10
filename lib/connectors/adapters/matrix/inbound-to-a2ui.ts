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

import type { InboundA2UIBlock, InboundA2UINode } from "../_shared/inbound-a2ui-types"
import type { MatrixTimelineEvent, MatrixEventContent } from "./parse"
import { stripReplyFallback } from "./parse"

/** `@local:server` → `local` for a friendlier mention chip. */
function localpart(userId: string): string {
  const m = /^@([^:]+):/.exec(userId)
  return m ? m[1] : userId
}

function mediaNode(content: MatrixEventContent): InboundA2UINode | null {
  const url = content.url
  if (!url) return null
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
      return { kind: "link", href: url, label: content.body || "Video" }
    case "m.audio":
      return { kind: "link", href: url, label: content.body || "Voice message" }
    case "m.file":
      return { kind: "link", href: url, label: content.filename || content.body || "Attachment" }
    default:
      return null
  }
}

export function matrixInboundToA2UI(ev: MatrixTimelineEvent): InboundA2UIBlock | null {
  if (!ev || typeof ev !== "object" || !ev.content) return null

  // For `m.replace` edits the renderable content lives in `m.new_content`;
  // the reply relation, when present, stays on the outer content.
  const rel = ev.content["m.relates_to"]
  const isEdit = rel?.rel_type === "m.replace" && rel.event_id !== undefined
  const content = isEdit ? (ev.content["m.new_content"] ?? ev.content) : ev.content

  const body: InboundA2UINode[] = []

  const inReplyTo = rel?.["m.in_reply_to"]?.event_id
  if (inReplyTo) {
    body.push({ kind: "reply_context", replyToMessageId: inReplyTo })
  }

  const media = mediaNode(content)
  if (media) {
    body.push(media)
  } else {
    const raw = content.body ?? ""
    const text = inReplyTo ? stripReplyFallback(raw) : raw
    if (text) body.push({ kind: "text", text })
  }

  for (const uid of content["m.mentions"]?.user_ids ?? []) {
    if (uid) body.push({ kind: "mention", handle: uid, resolved: localpart(uid) })
  }

  if (body.length === 0) return null
  return { v: 1, source: "matrix", body, raw: ev }
}
