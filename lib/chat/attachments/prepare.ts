/** Pre-stage validation and oversized-image rescue for composer attachments. */

import { downscaleImage } from "@/lib/ocr/image-prep"
import { detectDocumentTypeFromFilename } from "@cognia/document/support-matrix"

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
}

export interface PreparedComposerAttachments {
  files: File[]
  unsupportedCount: number
  tooLargeCount: number
  optimizedCount: number
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
  // Animated GIFs should not be flattened into a single canvas frame. They are
  // still accepted below the normal limit and rejected normally above it.
  if (file.type === "image/gif") return file
  const bytes = new Uint8Array(await file.arrayBuffer())
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

  for (const original of incoming) {
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

  return { files, unsupportedCount, tooLargeCount, optimizedCount }
}
