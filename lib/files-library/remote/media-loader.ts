/**
 * The media-cache fallback for a paired device's Files thumbnails and
 * previews (ADR-0223 §9). `acquireMedia` runs it only after the local media
 * store misses, so an image read once stays readable offline, and the row it
 * returns is the same shape the remote transcript's loader caches
 * (`hooks/chat/session-media-provider.tsx`). The bytes come through the
 * entry's own resources — the library pin, then a conversation that shows it.
 */

import type { MissingMediaLoader } from "@/lib/chat/media/resolve-media"
import type { FilesEntry } from "../types"
import type { FilesRemoteClient } from "./client"

export function createRemoteMediaLoader(
  client: Pick<FilesRemoteClient, "readMedia">,
  entry: FilesEntry
): MissingMediaLoader {
  return async ({ hash, variant }) => {
    const response = await client.readMedia(entry, variant)
    const bytes = Uint8Array.from(response.bytes)
    const now = Date.now()
    const blob = new Blob([bytes.buffer], { type: response.mediaType })
    return {
      hash,
      mediaType: response.mediaType,
      width: 0,
      height: 0,
      blob,
      byteSize: bytes.byteLength,
      canonicalAvailable: variant === "canonical",
      ...(variant === "thumbnail" ? { thumbBlob: blob, thumbWidth: 0, thumbHeight: 0 } : {}),
      createdAt: now,
      lastUsedAt: now,
    }
  }
}
