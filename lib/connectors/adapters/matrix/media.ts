/**
 * Matrix inbound media resolver.
 *
 * Parser output keeps Matrix `mxc://` references in `rawUrl` and exposes an
 * authenticated download URL in `url`. This pass fetches the media through the
 * shared encrypted attachment cache and, for small images, attaches inline
 * base64 so the existing OCR / vision path can consume the image bytes.
 *
 * Inlining reads the bytes back through the `connectors_attachment_read`
 * Tauri command (decrypt-on-read, size-capped) — NOT through `node:fs`, which
 * `next.config.ts` stubs out of every production bundle.
 */

import { fetchAttachment } from "@/lib/connectors/attachment-fetcher"
import { connectorsAttachmentRead } from "@/lib/connectors/tauri/commands"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"

const INLINE_IMAGE_LIMIT_BYTES = 6 * 1024 * 1024

export interface ResolveInboundMatrixMediaOptions {
  accessToken: string
}

export async function resolveInboundMatrixMedia(
  event: NormalizedInboundEvent,
  options: ResolveInboundMatrixMediaOptions
): Promise<void> {
  for (const seg of event.segments) {
    if (!isMatrixMediaSegment(seg)) continue
    try {
      const rawUrl = seg.rawUrl
      await fetchAttachment({
        adapterId: event.adapterId,
        remoteRef: rawUrl,
        sourceUrl: seg.url,
        mimeType: mediaMimeType(seg),
        sizeBytes: mediaSizeBytes(seg),
        headers: { Authorization: `Bearer ${options.accessToken}` },
      })
      if (seg.type === "image") {
        await inlineSmallImage(seg, event.adapterId, rawUrl)
      }
    } catch {
      // Best-effort: media fetch failure must not block message delivery.
    }
  }
}

function isMatrixMediaSegment(seg: MessageSegment): seg is Extract<
  MessageSegment,
  { type: "image" | "video" | "voice" | "file" }
> & {
  rawUrl: string
} {
  return (
    (seg.type === "image" || seg.type === "video" || seg.type === "voice" || seg.type === "file") &&
    typeof seg.rawUrl === "string" &&
    seg.rawUrl.startsWith("mxc://")
  )
}

function mediaMimeType(seg: MessageSegment): string | undefined {
  if (seg.type === "image" || seg.type === "video" || seg.type === "voice" || seg.type === "file") {
    return seg.mimeType
  }
  return undefined
}

function mediaSizeBytes(seg: MessageSegment): number | undefined {
  return seg.type === "file" ? seg.sizeBytes : undefined
}

async function inlineSmallImage(
  seg: Extract<MessageSegment, { type: "image" }>,
  adapterId: string,
  remoteRef: string
): Promise<void> {
  const base64 = await connectorsAttachmentRead(adapterId, remoteRef, INLINE_IMAGE_LIMIT_BYTES)
  if (base64) seg.dataBase64 = base64
}
