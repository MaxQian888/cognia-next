/**
 * Attachment staging for the Browser Companion (ADR-0228 §3).
 *
 * A browser cannot use `session_attachment_upload_*`: those need
 * `workspace.write`, and they bind an upload to a session that, for a new task,
 * does not exist until the submission creates it. So the browser gets four
 * commands of its own under `browser.submit`, and they stage into the SAME
 * store the composer and the phone use — same chunking, same commit-time
 * length / hash / magic-byte / malicious-content checks, same expiry.
 *
 * Two things differ, and both keep `browser.submit` one closed effect:
 *
 *  - **The caller is the Host.** Rows are written under
 *    {@link BROWSER_COMPANION_HOST_DEVICE}, the caller `enqueueOnHostAuthority`
 *    submits as, because HostState re-checks at enqueue that a ref belongs to
 *    the submitting caller. The browser never acts as that caller; it can only
 *    reach rows through this module.
 *  - **The row is keyed to the browser and the submission** by a placeholder
 *    session id, {@link stagingSessionId}. Every command re-derives it from the
 *    server-verified device id, so a browser can neither touch another
 *    browser's upload nor attach bytes staged for one submission to another.
 *    When the submission lands, {@link resolveBrowserAttachments} moves the rows
 *    onto the conversation it created.
 */
import {
  BROWSER_ATTACHMENT_MEDIA_TYPES,
  BROWSER_CONTEXT_LIMITS,
  type BrowserAttachmentKind,
  type BrowserAttachmentRefV1,
  type BrowserAttachmentUploadChunkResponseV1,
  type BrowserAttachmentUploadCommitResponseV1,
  type BrowserAttachmentUploadInitResponseV1,
} from "@/types/browser-companion"
import {
  AttachmentUploadError,
  abortAttachmentUpload,
  appendAttachmentChunk,
  beginAttachmentUpload,
  commitAttachmentUpload,
  readAttachmentUploadMeta,
  rebindAttachmentUploads,
  uploadRef,
} from "@/lib/db/session-attachment-uploads"

import { BrowserCompanionError, type BrowserStagedAttachment } from "./service"

/** The caller every browser attachment is staged and enqueued under. */
export const BROWSER_COMPANION_HOST_DEVICE = "host:browser-companion"

const STAGING_PREFIX = "browser-submission:"

/** The placeholder session a browser's upload for one submission lives under. */
export function stagingSessionId(deviceId: string, submissionId: string): string {
  return `${STAGING_PREFIX}${deviceId}:${submissionId}`
}

function stagingPrefixFor(deviceId: string): string {
  return `${STAGING_PREFIX}${deviceId}:`
}

/** The file-name extension a media type must carry, so documents route by name. */
const EXTENSION_FOR: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
}

const ATTACHMENT_KINDS: readonly BrowserAttachmentKind[] = ["screenshot", "pdf", "image"]

/**
 * A file name the store can route, derived from what the browser said.
 *
 * Kept to a safe character set and forced to the media type's extension: the
 * name is shown in the conversation and is how a PDF is recognised as one, and
 * a page title copied into it may carry anything.
 */
export function stagedAttachmentName(name: string, mediaType: string): string {
  const extension = EXTENSION_FOR[mediaType] ?? "bin"
  const base =
    name
      .replace(/\.[a-z0-9]{1,5}$/i, "")
      .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "attachment"
  return `${base}.${extension}`
}

/**
 * Decode one chunk, refusing rather than truncating malformed input — the same
 * rule `desktop-write-source.ts` applies to the composer's chunks. A chunk that
 * decoded short would pass the offset check and only fail as a hash mismatch at
 * the end of the transfer.
 */
export function decodeStrictBase64(raw: string): Uint8Array {
  if (raw.length === 0 || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    throw new BrowserCompanionError("malformed", "dataBase64 is not valid base64")
  }
  const binary = atob(raw)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function companionError(error: unknown): never {
  if (error instanceof AttachmentUploadError) {
    throw new BrowserCompanionError(error.code, error.code)
  }
  throw error
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== "string" || !value) {
    throw new BrowserCompanionError("malformed", `${key} is missing or invalid`)
  }
  return value
}

/** An upload this browser staged, or `attachment_not_found`. */
async function ownedUpload(deviceId: string, uploadId: string) {
  const meta = await readAttachmentUploadMeta(uploadId)
  if (
    !meta ||
    meta.deviceId !== BROWSER_COMPANION_HOST_DEVICE ||
    !meta.sessionId.startsWith(stagingPrefixFor(deviceId))
  ) {
    throw new BrowserCompanionError("attachment_not_found", "no such upload for this device")
  }
  return meta
}

export async function initBrowserAttachmentUpload(
  deviceId: string,
  payload: Record<string, unknown>
): Promise<BrowserAttachmentUploadInitResponseV1> {
  if (!deviceId) throw new BrowserCompanionError("caller_unbound", "the caller device is unknown")
  const submissionId = requireString(payload, "submissionId")
  const mediaType = requireString(payload, "mediaType")
  const name = requireString(payload, "name")
  const hash = requireString(payload, "hash")
  const kind = payload.kind
  const size = payload.size
  if (!BROWSER_ATTACHMENT_MEDIA_TYPES.includes(mediaType)) {
    throw new BrowserCompanionError("attachment_unsupported_type", "unsupported attachment type")
  }
  if (!ATTACHMENT_KINDS.includes(kind as BrowserAttachmentKind)) {
    throw new BrowserCompanionError("malformed", "kind is missing or invalid")
  }
  if (typeof size !== "number" || !Number.isInteger(size)) {
    throw new BrowserCompanionError("malformed", "size is missing or invalid")
  }
  try {
    const begun = await beginAttachmentUpload({
      sessionId: stagingSessionId(deviceId, submissionId),
      deviceId: BROWSER_COMPANION_HOST_DEVICE,
      name: stagedAttachmentName(name, mediaType),
      mediaType,
      size,
      hash,
      maxBytes: BROWSER_CONTEXT_LIMITS.attachmentBytes,
      maxConcurrent: BROWSER_CONTEXT_LIMITS.maxAttachments,
    })
    return {
      uploadId: begun.uploadId,
      chunkSize: begun.chunkSize,
      receivedBytes: begun.resumeOffset,
      ...(begun.complete ? { attachmentId: begun.uploadId } : {}),
    }
  } catch (error) {
    companionError(error)
  }
}

export async function writeBrowserAttachmentChunk(
  deviceId: string,
  payload: Record<string, unknown>
): Promise<BrowserAttachmentUploadChunkResponseV1> {
  const uploadId = requireString(payload, "uploadId")
  const offset = payload.offset
  const data = payload.dataBase64
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new BrowserCompanionError("malformed", "offset is missing or invalid")
  }
  if (typeof data !== "string") {
    throw new BrowserCompanionError("malformed", "dataBase64 is missing or invalid")
  }
  await ownedUpload(deviceId, uploadId)
  const bytes = decodeStrictBase64(data)
  try {
    const appended = await appendAttachmentChunk({
      uploadId,
      deviceId: BROWSER_COMPANION_HOST_DEVICE,
      offset,
      bytes,
    })
    return { receivedBytes: appended.receivedBytes }
  } catch (error) {
    companionError(error)
  }
}

export async function commitBrowserAttachmentUpload(
  deviceId: string,
  payload: Record<string, unknown>
): Promise<BrowserAttachmentUploadCommitResponseV1> {
  const uploadId = requireString(payload, "uploadId")
  await ownedUpload(deviceId, uploadId)
  try {
    await commitAttachmentUpload({ uploadId, deviceId: BROWSER_COMPANION_HOST_DEVICE })
    return { attachmentId: uploadId }
  } catch (error) {
    companionError(error)
  }
}

export async function abortBrowserAttachmentUpload(
  deviceId: string,
  payload: Record<string, unknown>
): Promise<null> {
  const uploadId = requireString(payload, "uploadId")
  const meta = await readAttachmentUploadMeta(uploadId)
  // Idempotent, and silent about uploads that are not this browser's — the
  // same answer as one that was already gone.
  if (
    meta &&
    meta.deviceId === BROWSER_COMPANION_HOST_DEVICE &&
    meta.sessionId.startsWith(stagingPrefixFor(deviceId))
  ) {
    await abortAttachmentUpload({ uploadId, deviceId: BROWSER_COMPANION_HOST_DEVICE })
  }
  return null
}

/**
 * Bind a submission's attachments to the conversation it lands in.
 *
 * The {@link BrowserCompanionDeps.resolveAttachments} production arm. Refuses
 * the whole set as `unknown_attachment` when any id is not a committed upload
 * this browser staged for this very submission.
 */
export async function resolveBrowserAttachments(input: {
  deviceId: string
  submissionId: string
  sessionId: string
  attachments: readonly BrowserAttachmentRefV1[]
}): Promise<BrowserStagedAttachment[]> {
  const kinds = new Map(input.attachments.map((entry) => [entry.attachmentId, entry.kind]))
  try {
    const rows = await rebindAttachmentUploads({
      uploadIds: input.attachments.map((entry) => entry.attachmentId),
      deviceId: BROWSER_COMPANION_HOST_DEVICE,
      fromSessionId: stagingSessionId(input.deviceId, input.submissionId),
      toSessionId: input.sessionId,
    })
    return rows.map((row) => ({
      name: row.name,
      mediaType: row.mediaType,
      size: row.size,
      hash: row.hash,
      ref: uploadRef(row.uploadId),
      kind: kinds.get(row.uploadId) ?? "image",
    }))
  } catch (error) {
    if (error instanceof AttachmentUploadError) {
      throw new BrowserCompanionError(
        "unknown_attachment",
        "an attachment is not one this browser staged for this submission"
      )
    }
    throw error
  }
}
