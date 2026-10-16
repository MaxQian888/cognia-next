/**
 * Upload one attachment for a submission (ADR-0228 §3).
 *
 * init → chunks → commit, against the Host's own upload staging. The Host
 * answers the chunk size and how much it already holds, so a retried upload
 * resumes instead of starting over, and an identical file it already has is
 * answered at init. Any failure aborts the staged upload — best effort, since
 * the Host also expires abandoned staging — and rethrows.
 */
import {
  BROWSER_ATTACHMENT_MEDIA_TYPES,
  BROWSER_CONTEXT_LIMITS,
  type BrowserAttachmentKind,
  type BrowserAttachmentRefV1,
} from "@cognia/companion-client"

import type { HostClient } from "./client"

export interface AttachmentFile {
  name: string
  mediaType: string
  kind: BrowserAttachmentKind
  bytes: Uint8Array
}

export class AttachmentUploadError extends Error {
  constructor(
    readonly code:
      "attachment_too_large" | "attachment_type_unsupported" | "attachment_upload_failed",
    message: string
  ) {
    super(message)
    this.name = "AttachmentUploadError"
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function uploadAttachment(
  client: Pick<HostClient, "uploadInit" | "uploadChunk" | "uploadCommit" | "uploadAbort">,
  submissionId: string,
  file: AttachmentFile,
  options: {
    maxBytes?: number
    onProgress?: (sentBytes: number, totalBytes: number) => void
    signal?: AbortSignal
  } = {}
): Promise<BrowserAttachmentRefV1> {
  const maxBytes = options.maxBytes ?? BROWSER_CONTEXT_LIMITS.attachmentBytes
  if (!BROWSER_ATTACHMENT_MEDIA_TYPES.includes(file.mediaType)) {
    throw new AttachmentUploadError(
      "attachment_type_unsupported",
      `${file.mediaType} cannot be attached`
    )
  }
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > maxBytes) {
    throw new AttachmentUploadError(
      "attachment_too_large",
      `${file.name} is larger than ${maxBytes} bytes`
    )
  }

  const init = await client.uploadInit({
    submissionId,
    name: file.name,
    mediaType: file.mediaType,
    kind: file.kind,
    size: file.bytes.byteLength,
    hash: await sha256Hex(file.bytes),
  })
  if (init.attachmentId) {
    options.onProgress?.(file.bytes.byteLength, file.bytes.byteLength)
    return { attachmentId: init.attachmentId, kind: file.kind }
  }

  try {
    const chunkSize = Math.max(1, init.chunkSize)
    let offset = Math.min(Math.max(0, init.receivedBytes), file.bytes.byteLength)
    options.onProgress?.(offset, file.bytes.byteLength)
    while (offset < file.bytes.byteLength) {
      if (options.signal?.aborted) throw new DOMException("upload aborted", "AbortError")
      const end = Math.min(file.bytes.byteLength, offset + chunkSize)
      const { receivedBytes } = await client.uploadChunk({
        uploadId: init.uploadId,
        offset,
        dataBase64: bytesToBase64(file.bytes.subarray(offset, end)),
      })
      // The Host's count is the truth: it may already hold more than this
      // chunk, never less without saying so.
      if (receivedBytes < end) {
        throw new AttachmentUploadError(
          "attachment_upload_failed",
          `the Host holds ${receivedBytes} bytes after a chunk ending at ${end}`
        )
      }
      offset = receivedBytes
      options.onProgress?.(offset, file.bytes.byteLength)
    }
    const { attachmentId } = await client.uploadCommit(init.uploadId)
    return { attachmentId, kind: file.kind }
  } catch (error) {
    await client.uploadAbort(init.uploadId).catch(() => undefined)
    throw error
  }
}
