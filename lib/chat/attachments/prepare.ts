/** Pre-stage validation and oversized-image rescue for composer attachments. */

import { downscaleImage } from "@/lib/ocr/image-prep"
import { detectDocumentTypeFromFilename } from "@cognia/document/support-matrix"

export const COMPOSER_IMAGE_MAX_LONG_EDGE = 1568

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

export function isSupportedComposerAttachment(file: File): boolean {
  return file.type.startsWith("image/") || detectDocumentTypeFromFilename(file.name) !== "unknown"
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
