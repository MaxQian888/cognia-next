/**
 * Projects the composer's staged attachments down to the rows we persist in a
 * chat draft.
 *
 * This used to keep name / media-type / size only, deliberately dropping the
 * binary — which meant switching sessions silently destroyed whatever the user
 * had staged. The binary is now carried too (subject to
 * `DRAFT_ATTACHMENT_QUOTA_BYTES`), along with the cached extraction so a
 * restored document is not re-parsed.
 */

import type { DraftAttachmentMeta } from "@/lib/db/chat-drafts"

export interface DraftSourceFile {
  id: string
  filename?: string
  mediaType?: string
  url?: string
}

/** The slice of a staged attachment's derived state that a draft persists. */
export interface DraftSourceState {
  sizeBytes: number
  bytes?: Uint8Array
  extracted?: { text?: string; tokens: number }
}

/**
 * Estimate the decoded byte size of a `data:` URL's base64 payload. Returns 0
 * for non-data URLs (e.g. `blob:`) where the original size isn't recoverable.
 *
 * Retained for callers that only hold a URL. It is NOT how a draft's size is
 * computed any more: staged attachments carry `blob:` URLs, so this returned 0
 * for every one of them and the size was never shown.
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
  files: readonly DraftSourceFile[],
  states?: ReadonlyMap<string, DraftSourceState>
): DraftAttachmentMeta[] {
  return files.map((f) => {
    const state = states?.get(f.id)
    // Fall back to the URL estimate only when there is no staged state (e.g. a
    // caller outside the composer); it yields 0 for blob: URLs.
    const size = state?.sizeBytes ?? estimateDataUrlBytes(f.url)
    return {
      name: f.filename ?? "attachment",
      mediaType: f.mediaType ?? "application/octet-stream",
      size,
      ...(state?.bytes ? { bytes: state.bytes } : {}),
      ...(state?.extracted?.text ? { extractedText: state.extracted.text } : {}),
      ...(state?.extracted?.tokens ? { tokens: state.extracted.tokens } : {}),
    }
  })
}
