/**
 * Projects the composer's staged attachment parts down to the lightweight
 * {@link DraftAttachmentMeta} we persist in a chat draft. We deliberately keep
 * only name / media-type / size — never the binary — so a restored draft can
 * remind the user which files to re-attach without bloating IndexedDB.
 */

import type { DraftAttachmentMeta } from "@/lib/db/chat-drafts"

export interface DraftSourceFile {
  filename?: string
  mediaType?: string
  url?: string
}

/**
 * Estimate the decoded byte size of a `data:` URL's base64 payload. Returns 0
 * for non-data URLs (e.g. `blob:`) where the original size isn't recoverable —
 * the size is informational only, so 0 simply renders as "—".
 */
export function estimateDataUrlBytes(url: string | undefined): number {
  if (!url || !url.startsWith("data:")) return 0
  const comma = url.indexOf(",")
  if (comma < 0) return 0
  const payload = url.slice(comma + 1)
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

export function draftAttachmentsFromFiles(
  files: readonly DraftSourceFile[]
): DraftAttachmentMeta[] {
  return files.map((f) => ({
    name: f.filename ?? "attachment",
    mediaType: f.mediaType ?? "application/octet-stream",
    size: estimateDataUrlBytes(f.url),
  }))
}
