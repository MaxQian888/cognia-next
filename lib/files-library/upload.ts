/**
 * "New → Upload" on the Files page (ADR-0200). The file belongs to Files, not
 * to any conversation.
 *
 *   - A raster image within the chat image limit goes through the same
 *     `ingestImage` as a chat upload (canonical frame + thumbnail + original),
 *     so it is one card with the image a conversation would show.
 *   - Anything else is stored as a Files-owned original. Its text is extracted
 *     now, by the same `extractAttachment` the composer runs, so Files and ⌘K
 *     can search the body; a file above `FILES_EXTRACT_MAX_BYTES` is stored as
 *     bytes only and extracted when a conversation first uses it.
 */

import { extractAttachment } from "@/lib/chat/attachments/dispatch"
import { ingestImage, MAX_IMAGE_INPUT_BYTES } from "@/lib/chat/media/ingest-media"
import { markLibraryItemOwned } from "@/lib/db/files-library-items"
import { libraryItemKey } from "@/lib/db/files-library-types"
import { parseMediaRef } from "@/lib/db/message-media"
import { putLibraryAsset } from "@/lib/db/session-assets"
import { readBlobAsArrayBuffer } from "@cognia/ocr/blob-utils"
import { bytesToDataUrl } from "@cognia/ocr/image-prep"
import { loggers } from "@cognia/logging"

/** Largest file whose text is extracted at upload time. */
export const FILES_EXTRACT_MAX_BYTES = 50 * 1024 * 1024

export interface FilesUploadResult {
  key: string
  kind: "image" | "upload"
  /** False when the text could not be extracted (unsupported type, too large, parse failure). */
  extracted: boolean
}

/** Raster images take the image pipeline; SVG is a document (it can carry script). */
export function isIngestibleImage(file: Pick<File, "type" | "size">): boolean {
  const type = file.type.toLowerCase()
  return type.startsWith("image/") && type !== "image/svg+xml" && file.size <= MAX_IMAGE_INPUT_BYTES
}

function newAssetId(): string {
  return `asset-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
}

export async function uploadFileToLibrary(
  file: File,
  options: { projectId?: string } = {}
): Promise<FilesUploadResult> {
  const mediaType = file.type || "application/octet-stream"
  if (isIngestibleImage(file)) {
    const ingested = await ingestImage({
      bytes: new Uint8Array(await readBlobAsArrayBuffer(file)),
      mediaType,
      keepOriginal: true,
    })
    const hash = parseMediaRef(ingested.ref)!
    await markLibraryItemOwned({
      kind: "image",
      sourceId: hash,
      mediaHash: hash,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      snapshot: { title: file.name, mediaType: ingested.mediaType, byteSize: ingested.byteSize },
    })
    return { key: libraryItemKey("image", hash), kind: "image", extracted: false }
  }

  const assetId = newAssetId()
  let extractedContent: Awaited<ReturnType<typeof extractAttachment>>["extractedContent"]
  if (file.size <= FILES_EXTRACT_MAX_BYTES) {
    try {
      const result = await extractAttachment({
        url: bytesToDataUrl(new Uint8Array(await readBlobAsArrayBuffer(file)), mediaType),
        mediaType,
        filename: file.name,
        id: assetId,
      })
      if (result.kind === "document" && result.extractedContent) {
        extractedContent = result.extractedContent
      }
    } catch (error) {
      // Stored without text; the composer extracts again when it is used.
      loggers.store.warn("files upload extraction failed", { error: String(error) })
    }
  }
  await putLibraryAsset({
    assetId,
    blob: file,
    filename: file.name,
    mediaType,
    ...(extractedContent ? { extractedContent } : {}),
    ...(options.projectId ? { projectId: options.projectId } : {}),
  })
  return {
    key: libraryItemKey("upload", assetId),
    kind: "upload",
    extracted: extractedContent !== undefined,
  }
}
