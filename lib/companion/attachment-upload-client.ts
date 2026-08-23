"use client"

/**
 * Client half of the session attachment upload protocol (ADR-0005 §4.5).
 *
 * A remote composer holds the only copy of a staged file. `message.enqueue`
 * carries refs, not bytes, so the file has to reach the Host first — through
 * `session_attachment_upload_init` → `…_chunk`* → `…_commit`, which hands back
 * the ref the message then names.
 *
 * Everything about the transfer is the Host's decision and this module obeys
 * it rather than guessing:
 *
 *  - **chunk size** comes from the init response, not a constant here. A client
 *    that chose its own would eventually pick one the Host's RPC body ceiling
 *    rejects, and the failure would look like a broken file rather than a
 *    misconfigured client.
 *  - **where to resume** comes from the init response too. Re-staging a file
 *    the Host already holds costs one round trip instead of the whole upload,
 *    which is what makes a retry over a mobile radio finish at all.
 *  - **the ref** is minted by the Host. Nothing here can name a location the
 *    Host will read, which is the whole point of a ref rather than a path.
 *
 * The hash is computed once, before init, and reused as the dedupe key. It is
 * also what the Host verifies at commit, so a chunk corrupted in transit fails
 * loudly at the end of the transfer rather than becoming a file the model is
 * quietly handed.
 */

import { bytesToBase64 } from "@/lib/ocr/image-prep"
import { sha256Bytes } from "@/lib/ocr/hash"
import { transport } from "@/lib/tauri"

/** A staged file, in the only form the uploader needs. */
export interface UploadableAttachment {
  name: string
  mediaType: string
  bytes: Uint8Array
  /**
   * SHA-256 of `bytes`, if the caller already has it (a restored draft does).
   * Skips a full re-hash, which on a phone is the whole cost of a resume.
   */
  hash?: string
}

/** What the message ends up carrying for one file. */
export interface UploadedAttachment {
  ref: string
  name: string
  mediaType: string
  size: number
  hash: string
}

export interface AttachmentUploadProgress {
  /** Bytes the Host has confirmed it holds. */
  uploadedBytes: number
  totalBytes: number
  /** Present from the first init response; lets a caller persist it for resume. */
  uploadId: string
}

/** The RPC seam, injectable so tests do not need a transport. */
export type AttachmentUploadCall = (name: string, args: Record<string, unknown>) => Promise<unknown>

export interface UploadSessionAttachmentOptions {
  /**
   * Precomputed SHA-256. Passing the one already stored on the draft skips a
   * full re-hash of the bytes on every resume, which on a phone is the
   * difference between a resumed upload being cheap and being the same cost as
   * starting over.
   */
  hash?: string
  onProgress?: (progress: AttachmentUploadProgress) => void
  call?: AttachmentUploadCall
}

interface InitResponse {
  uploadId: string
  chunkSize: number
  resumeOffset: number
  complete: boolean
  ref: string | null
}

interface ChunkResponse {
  receivedBytes: number
  complete: boolean
}

interface CommitResponse {
  ref: string
  name: string
  mediaType: string
  size: number
  hash: string
}

function defaultCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  return transport.call(name, args)
}

/**
 * Upload one staged file and return the ref a message may carry.
 *
 * Idempotent on content: calling it twice for the same bytes in the same
 * session resolves the second time without re-sending anything, because init
 * recognizes the hash. That is what makes "retry the send" safe after a
 * partial failure — the composer does not have to know which files already
 * made it across.
 */
export async function uploadSessionAttachment(
  sessionId: string,
  file: UploadableAttachment,
  options: UploadSessionAttachmentOptions = {}
): Promise<UploadedAttachment> {
  const call = options.call ?? defaultCall
  const hash = options.hash ?? (await sha256Bytes(file.bytes))

  const init = (await call("session_attachment_upload_init", {
    sessionId,
    name: file.name,
    mediaType: file.mediaType,
    size: file.bytes.byteLength,
    hash,
  })) as InitResponse

  const total = file.bytes.byteLength
  options.onProgress?.({
    uploadedBytes: Math.min(init.resumeOffset, total),
    totalBytes: total,
    uploadId: init.uploadId,
  })

  if (init.complete && init.ref) {
    return { ref: init.ref, name: file.name, mediaType: file.mediaType, size: total, hash }
  }

  // `chunkSize` is only ever a suggestion in the sense that a nonsense value
  // must not wedge the loop: a zero or negative would never advance the offset.
  const chunkSize = init.chunkSize > 0 ? init.chunkSize : 32 * 1024
  let offset = Math.min(Math.max(init.resumeOffset, 0), total)

  while (offset < total) {
    const end = Math.min(offset + chunkSize, total)
    const response = (await call("session_attachment_upload_chunk", {
      uploadId: init.uploadId,
      offset,
      dataBase64: bytesToBase64(file.bytes.subarray(offset, end)),
    })) as ChunkResponse
    // Follow the Host's write head rather than our own arithmetic. It is the
    // side that knows what it kept, and a resumed upload whose first chunk
    // overlapped what was already stored would otherwise leave the two
    // permanently one chunk apart.
    const confirmed = Number.isFinite(response?.receivedBytes) ? response.receivedBytes : end
    offset = Math.min(Math.max(confirmed, end), total)
    options.onProgress?.({ uploadedBytes: offset, totalBytes: total, uploadId: init.uploadId })
  }

  const committed = (await call("session_attachment_upload_commit", {
    uploadId: init.uploadId,
  })) as CommitResponse
  return {
    ref: committed.ref,
    name: committed.name,
    // The Host may correct the type it was told — a screenshot saved as `.png`
    // that is really a JPEG, say. Carrying the corrected value is what makes
    // the model render it instead of failing to decode it.
    mediaType: committed.mediaType,
    size: committed.size,
    hash: committed.hash,
  }
}

/**
 * Discard a partial upload, freeing the staging slot it holds on the Host.
 *
 * Best-effort by design: the caller is already giving up on the file, and the
 * TTL collects the row anyway. Failing loudly here would turn "you removed an
 * attachment" into an error toast about a cleanup the user never asked for.
 */
export async function abortSessionAttachmentUpload(
  uploadId: string,
  options: { call?: AttachmentUploadCall } = {}
): Promise<void> {
  const call = options.call ?? defaultCall
  try {
    await call("session_attachment_upload_abort", { uploadId })
  } catch {
    // Ignore — see above.
  }
}
