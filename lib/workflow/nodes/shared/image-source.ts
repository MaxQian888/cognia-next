/**
 * Resolve an image input for a workflow node.
 *
 * Four accepted shapes, mirroring `resolveOcrNodeSource` in
 * `../data/ocr.ts` and adding the one that module could not have: a
 * `blobRef` into the run-scoped blob store. Sharing the vocabulary is what
 * makes `ocr.extract` able to consume an image node's output on day one,
 * without touching the OCR node at all.
 */

import { decodeBlobToPixelBuffer } from "@/lib/images/codec"
import type { PixelBuffer } from "@/lib/images/pixel-buffer"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { isWorkflowBlobRef, openWorkflowBlob } from "@/lib/workflow/blobs/store"
import { nonRetryable } from "./executor-support"

export interface ResolvedImageSource {
  buffer: PixelBuffer
  /** What the bytes were before decoding, when the caller told us. */
  sourceMediaType?: string
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export const IMAGE_SOURCE_FIELDS = ["blobRef", "dataUrl", "imageBase64", "url"] as const

export async function resolveImageSource(
  params: Record<string, unknown>,
  kind: string
): Promise<ResolvedImageSource> {
  const blobRef = str(params, "blobRef")
  if (blobRef) {
    if (!isWorkflowBlobRef(blobRef)) {
      throw nonRetryable(`${kind}: '${blobRef}' is not a workflow blob reference`)
    }
    const blob = await openWorkflowBlob(blobRef)
    return {
      buffer: await decodeBlobToPixelBuffer(
        new Blob([blob.bytes as unknown as BlobPart], { type: blob.mediaType })
      ),
      sourceMediaType: blob.mediaType,
    }
  }

  const dataUrl = str(params, "dataUrl")
  if (dataUrl) {
    const response = await fetch(dataUrl)
    const blob = await response.blob()
    return { buffer: await decodeBlobToPixelBuffer(blob), sourceMediaType: blob.type || undefined }
  }

  const imageBase64 = str(params, "imageBase64")
  if (imageBase64) {
    const mediaType = str(params, "mimeType") ?? "image/png"
    const bytes = base64ToBytes(imageBase64)
    return {
      buffer: await decodeBlobToPixelBuffer(
        new Blob([bytes as unknown as BlobPart], { type: mediaType })
      ),
      sourceMediaType: mediaType,
    }
  }

  const url = str(params, "url")
  if (url) {
    // `proxyFetch`, like every other workflow egress: the image lives on
    // whatever host the author pointed at, which `connect-src` does not list.
    const blob = await (await proxyFetch(url)).blob()
    return { buffer: await decodeBlobToPixelBuffer(blob), sourceMediaType: blob.type || undefined }
  }

  throw nonRetryable(`${kind}: no image source. Set one of ${IMAGE_SOURCE_FIELDS.join(", ")}.`)
}
