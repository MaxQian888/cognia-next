/**
 * The one place chat images are minted into the content-addressed store.
 *
 * Every entry point — composer attachments, computer-use screenshots, MCP tool
 * results, plugin media, session import — funnels through `ingestImage` so a
 * single policy governs what actually lands in a conversation: how large it
 * may be, whether a thumbnail exists, and whether the untouched original is
 * worth keeping. Before this existed the only down-scaling in the app hung off
 * one composer branch (`lib/chat/attachments/prepare.ts`), and only when a file
 * exceeded the size limit, so agent screenshots reached the transcript at
 * whatever resolution the screen happened to be.
 *
 * Addressing is by hash of the SOURCE bytes, not of the canonical output. That
 * ordering is what lets a repeat frame short-circuit before any canvas work:
 * agent transcripts re-send byte-identical screenshots constantly.
 */

import { downscaleImage, measureImage, decodeDataUrl } from "@/lib/ocr/image-prep"
import { mediaRef, putMessageMedia, hasMessageMedia } from "@/lib/db/message-media"

/**
 * Long edge of the canonical image: what renders inline and what the model is
 * sent. Matches `COMPOSER_IMAGE_MAX_LONG_EDGE` and Anthropic's own ceiling —
 * anything larger is down-scaled server-side anyway, so keeping it costs
 * storage and heap for no fidelity.
 */
export const CANONICAL_MAX_LONG_EDGE = 1568

/**
 * Long edge of the thumbnail. `MessageImageGallery` tiles images at 189px
 * squares inside `max-w-sm`; 512 covers that at 2x device pixels while
 * decoding a fraction of the canonical frame.
 */
export const THUMBNAIL_MAX_LONG_EDGE = 512

/** Below this the canonical image is already small; a thumbnail would be waste. */
export const THUMBNAIL_MIN_SOURCE_BYTES = 64 * 1024

export interface IngestedMedia {
  /** `cognia-media:<hash>` — what the message part carries. */
  ref: string
  mediaType: string
  width: number
  height: number
  byteSize: number
}

export interface IngestImageInput {
  bytes: Uint8Array
  mediaType: string
  /**
   * Keep the untouched source so "download" returns what the user gave us.
   * True for uploads and pastes; false for agent frames, which have no
   * original anyone wants back.
   */
  keepOriginal?: boolean
  /** Injected in tests. */
  now?: () => number
}

/**
 * Store `bytes` and return the reference plus the geometry the renderer needs
 * to reserve space before the blob is read back.
 *
 * Animated GIFs are stored untouched: every down-scale path here is
 * canvas-backed, and a canvas flattens an animation to its first frame. This
 * mirrors the rule already in `prepare.ts` and is the reason the check lives
 * before any decode.
 */
export async function ingestImage({
  bytes,
  mediaType,
  keepOriginal = false,
  now = Date.now,
}: IngestImageInput): Promise<IngestedMedia> {
  const hash = await sha256Hex(bytes)

  // Same source seen before: skip the decode, the re-encode and the write.
  if (await hasMessageMedia(hash)) {
    const known = await describeStored(hash)
    if (known) return known
  }

  const animated = mediaType === "image/gif"
  const canonical = animated
    ? { bytes, mimeType: mediaType }
    : await downscaleImage(bytes, mediaType, CANONICAL_MAX_LONG_EDGE)

  const size = (await measureImage(canonical.bytes, canonical.mimeType)) ?? { width: 0, height: 0 }

  // Only worth a second encode when the canonical is big enough that decoding
  // it for a gallery tile would cost something.
  const wantsThumb = !animated && canonical.bytes.byteLength > THUMBNAIL_MIN_SOURCE_BYTES
  const thumb = wantsThumb
    ? await downscaleImage(canonical.bytes, canonical.mimeType, THUMBNAIL_MAX_LONG_EDGE)
    : null
  // `downscaleImage` returns the input unchanged when it cannot do better, so
  // an identical byte length means there is no distinct thumbnail to store.
  const thumbIsDistinct = thumb !== null && thumb.bytes.byteLength < canonical.bytes.byteLength
  const thumbSize = thumbIsDistinct ? await measureImage(thumb.bytes, thumb.mimeType) : null

  const stamp = now()
  await putMessageMedia({
    hash,
    mediaType: canonical.mimeType,
    width: size.width,
    height: size.height,
    blob: new Blob([canonical.bytes as BlobPart], { type: canonical.mimeType }),
    byteSize: canonical.bytes.byteLength,
    ...(thumbIsDistinct
      ? {
          thumbBlob: new Blob([thumb.bytes as BlobPart], { type: thumb.mimeType }),
          thumbWidth: thumbSize?.width,
          thumbHeight: thumbSize?.height,
        }
      : {}),
    ...(keepOriginal && canonical.bytes !== bytes
      ? {
          originalBlob: new Blob([bytes as BlobPart], { type: mediaType }),
          originalByteSize: bytes.byteLength,
          originalMediaType: mediaType,
        }
      : {}),
    createdAt: stamp,
    lastUsedAt: stamp,
  })

  return {
    ref: mediaRef(hash),
    mediaType: canonical.mimeType,
    width: size.width,
    height: size.height,
    byteSize: canonical.bytes.byteLength,
  }
}

/**
 * Ingest a `data:` URL. Returns null when the string is not one — callers hold
 * values that may already be a reference, a remote URL, or a blob URL, and
 * pushing that discrimination in here keeps every call site from repeating it.
 */
export async function ingestImageDataUrl(
  dataUrl: string,
  options: Omit<IngestImageInput, "bytes" | "mediaType"> = {}
): Promise<IngestedMedia | null> {
  const decoded = decodeDataUrl(dataUrl)
  if (!decoded) return null
  return ingestImage({ bytes: decoded.bytes, mediaType: decoded.mimeType, ...options })
}

/** Hex SHA-256 of `bytes` via WebCrypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error("crypto.subtle unavailable — cannot content-address chat media")
  }
  // Slice to a standalone ArrayBuffer rather than handing the view straight
  // over: a `Uint8Array` may be a window onto a larger (or shared) buffer, and
  // `digest` types the two cases differently. One copy per ingested image is
  // negligible next to the hash itself.
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer
  const digest = await subtle.digest("SHA-256", buffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/** Describe an already-stored hash without re-reading its blob payloads. */
async function describeStored(hash: string): Promise<IngestedMedia | null> {
  const { getMessageMedia } = await import("@/lib/db/message-media")
  const row = await getMessageMedia(hash)
  if (!row) return null
  return {
    ref: mediaRef(row.hash),
    mediaType: row.mediaType,
    width: row.width,
    height: row.height,
    byteSize: row.byteSize,
  }
}
