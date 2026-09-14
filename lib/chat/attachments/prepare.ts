/** Pre-stage validation and oversized-image rescue for composer attachments. */

import { downscaleImage } from "@/lib/ocr/image-prep"
import { isAnimatedGif } from "@/lib/images/gif"
import { detectDocumentTypeFromFilename } from "@cognia/document/support-matrix"
import { isGifDescriptor, videoMediaTypeOf } from "./video/classify"

export const COMPOSER_IMAGE_MAX_LONG_EDGE = 1568

/**
 * How many files one message may carry, and how large each may be.
 *
 * Exported rather than kept private to the composer because the Host publishes
 * them in its feature manifest (`lib/platform/host-feature-manifest.ts`) and
 * enforces them again on `session_attachment_upload_init`. A remote client that
 * disagreed with the desktop about the ceiling would stage six 10 MB files and
 * then discover the refusal one upload at a time.
 */
export const COMPOSER_MAX_ATTACHMENTS = 6
export const COMPOSER_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/**
 * How large a video or GIF may be when it is preprocessed on this device
 * (decision D8). The source never leaves the device at this size: what is sent
 * is the frames sampled from it — held to {@link COMPOSER_MAX_ATTACHMENT_BYTES}
 * like any attachment — or, for native delivery, a file that is itself under
 * that ceiling. Deliberately NOT published in the Host feature manifest: a
 * remote upload is still bound by the 10 MB ceiling.
 */
export const COMPOSER_VIDEO_SOURCE_MAX_BYTES = 500 * 1024 * 1024

/**
 * How much of a file rides in one `session_attachment_upload_chunk` call.
 *
 * Base64 inflates by 4/3, so 32 KiB of payload is ~43 KB on the wire and still
 * clears the 64 KB RPC body ceiling (`HostFeatureLimits.rpcJsonBodyBytes`) with
 * room for the envelope. Matches `skillUploadChunkBytes`, which the same
 * transport already carries. Lives here with the other attachment ceilings so
 * the Host manifest can publish all of them without reaching into Dexie.
 */
export const ATTACHMENT_UPLOAD_CHUNK_BYTES = 32 * 1024

export interface PrepareComposerAttachmentsOptions {
  maxFileSize: number
  optimizeImage?: (file: File) => Promise<File>
  /**
   * Accept videos, and animated GIFs past `maxFileSize`, for the motion
   * pipeline that samples them on this device — up to `maxSourceBytes`.
   *
   * Opt-in, because only the chat composer preprocesses. The remote-session
   * composer uploads original bytes to a Host, and an IM platform conversation
   * hands files to a person; for both, a video stays unsupported exactly as
   * before, and the shared {@link isSupportedAttachmentDescriptor} (which the
   * Host's upload gate also applies) is deliberately left without video.
   */
  motion?: { maxSourceBytes: number }
}

export interface PreparedComposerAttachments {
  files: File[]
  unsupportedCount: number
  tooLargeCount: number
  optimizedCount: number
  /** Videos / animated GIFs over the motion source ceiling. */
  motionTooLargeCount: number
}

/**
 * The type gate, stated over metadata rather than over a `File`.
 *
 * The Host validates an upload it has not received yet — it holds a name and a
 * declared media type and nothing else — so the rule cannot live behind a
 * `File`. Sharing it means a remote device is refused by exactly the test the
 * desktop paperclip applies, instead of by a second list that drifts.
 */
export function isSupportedAttachmentDescriptor(descriptor: {
  name: string
  mediaType: string
}): boolean {
  return (
    descriptor.mediaType.startsWith("image/") ||
    detectDocumentTypeFromFilename(descriptor.name) !== "unknown"
  )
}

export function isSupportedComposerAttachment(file: File): boolean {
  return isSupportedAttachmentDescriptor({ name: file.name, mediaType: file.type })
}

async function downsampleFile(file: File): Promise<File> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // An animated GIF must not be flattened into one canvas frame. A still GIF is
  // just a picture, and is rescued like any other.
  if (file.type === "image/gif" && isAnimatedGif(bytes)) return file
  const scaled = await downscaleImage(bytes, file.type || "image/png", COMPOSER_IMAGE_MAX_LONG_EDGE)
  if (scaled.bytes.byteLength >= file.size) return file
  return new File([scaled.bytes as BlobPart], file.name, {
    type: scaled.mimeType || file.type,
    lastModified: file.lastModified,
  })
}

export async function prepareComposerAttachments(
  incoming: readonly File[],
  options: PrepareComposerAttachmentsOptions
): Promise<PreparedComposerAttachments> {
  const optimizeImage = options.optimizeImage ?? downsampleFile
  const files: File[] = []
  let unsupportedCount = 0
  let tooLargeCount = 0
  let optimizedCount = 0
  let motionTooLargeCount = 0

  for (const original of incoming) {
    const descriptor = { name: original.name, mediaType: original.type }
    const videoType = options.motion ? videoMediaTypeOf(descriptor) : null
    if (options.motion && videoType) {
      if (original.size > options.motion.maxSourceBytes) {
        motionTooLargeCount++
        continue
      }
      // A picker that reported no type still yields a `video/*` file, so every
      // later step classifies it the same way. Re-wrapping a Blob copies nothing.
      files.push(
        original.type === videoType
          ? original
          : new File([original], original.name, {
              type: videoType,
              lastModified: original.lastModified,
            })
      )
      continue
    }
    if (options.motion && isGifDescriptor(descriptor) && original.size > options.maxFileSize) {
      if (original.size > options.motion.maxSourceBytes) {
        motionTooLargeCount++
        continue
      }
      if (isAnimatedGif(new Uint8Array(await original.arrayBuffer()))) {
        files.push(original)
        continue
      }
      // A still GIF falls through to the ordinary image rescue below.
    }
    if (!isSupportedComposerAttachment(original)) {
      unsupportedCount++
      continue
    }
    let candidate = original
    if (original.type.startsWith("image/") && original.size > options.maxFileSize) {
      try {
        candidate = await optimizeImage(original)
      } catch {
        candidate = original
      }
      if (candidate.size < original.size) optimizedCount++
    }
    if (candidate.size > options.maxFileSize) {
      tooLargeCount++
      continue
    }
    files.push(candidate)
  }

  return { files, unsupportedCount, tooLargeCount, optimizedCount, motionTooLargeCount }
}
