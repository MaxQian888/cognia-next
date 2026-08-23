/**
 * Host-side staging for attachments a remote device uploads into a session
 * (Dexie v180, ADR-0005 §4.5).
 *
 * A phone that stages a screenshot in its composer holds the only copy of the
 * bytes. `message.enqueue` carries `HostStateAttachmentRef`s — name, media
 * type, size, hash — and nothing else, so until this module existed the Host
 * dispatched the text and silently dropped every file: the model was told
 * about an image it was never shown.
 *
 * The transfer is chunked rather than inlined for two reasons. The RPC body
 * ceiling is 64 KB (`HostFeatureLimits.rpcJsonBodyBytes`), which a single 10 MB
 * base64 attachment blows past by two orders of magnitude; and a mobile radio
 * drops often enough that a whole-file retry is the difference between "slow"
 * and "never finishes". Every row records how many bytes it already holds, so
 * `session_attachment_upload_init` can answer `resumeOffset` and the client
 * continues instead of restarting — across a reconnect and across an app
 * restart, since the client's own progress lives in its draft row.
 *
 * Three properties are load-bearing:
 *
 *  - **The row owns the binding.** `deviceId` and `sessionId` are written from
 *    the server-verified caller at init and never read from a later payload.
 *    A second device cannot append to, commit, or resolve someone else's
 *    upload even holding its id.
 *  - **Committing is where the claim is checked, not where it is trusted.**
 *    The declared length and hash are verified against the assembled bytes and
 *    the media type is sniffed from the magic bytes, so a `image/png` label on
 *    an executable is refused before anything can reference it.
 *  - **Nothing here is permanent.** An abandoned upload expires; a committed
 *    object that no message ever referenced is collected. The bytes exist only
 *    to survive the gap between "the phone had a file" and "the runtime got a
 *    prompt".
 *
 * The table lives in the per-target database, so revoking a Host — which drops
 * that database wholesale — takes the staged bytes with it. There is no second
 * cleanup path to forget to call.
 */

import { sha256Bytes } from "@/lib/ocr/hash"
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  COMPOSER_MAX_ATTACHMENTS,
  COMPOSER_MAX_ATTACHMENT_BYTES,
  isSupportedAttachmentDescriptor,
} from "@/lib/chat/attachments/prepare"
import { getDb } from "./schema"
import { readStoredBytes } from "./stored-bytes"

/** Prefix marking an attachment reference minted by a committed upload. */
export const UPLOAD_REF_PREFIX = "cognia-upload:"

/** `cognia-upload:<uploadId>` — the immutable ref `commit` hands back. */
export function uploadRef(uploadId: string): string {
  return `${UPLOAD_REF_PREFIX}${uploadId}`
}

/** The upload id inside a ref, or null for anything that is not one. */
export function parseUploadRef(value: string | undefined | null): string | null {
  if (!value || !value.startsWith(UPLOAD_REF_PREFIX)) return null
  const id = value.slice(UPLOAD_REF_PREFIX.length)
  return id.length > 0 ? id : null
}

export type SessionAttachmentUploadStatus = "uploading" | "committed"

export interface SessionAttachmentUploadRow {
  uploadId: string
  /** Session the attachment may be sent into. Bound at init. */
  sessionId: string
  /** Server-verified caller. The only device allowed to touch this row. */
  deviceId: string
  name: string
  /** Declared at init; replaced by the sniffed type at commit. */
  mediaType: string
  /** Declared total length. The commit refuses anything that disagrees. */
  size: number
  /** Client-computed SHA-256, lowercase hex. Verified at commit. */
  hash: string
  receivedBytes: number
  /** Assembled payload. Absent once the row has been collected. */
  bytes?: Uint8Array
  status: SessionAttachmentUploadStatus
  createdAt: number
  updatedAt: number
  /** When an untouched row becomes collectable. Pushed forward on every write. */
  expiresAt: number
  /** Set once a message actually carried this ref, which pins it against GC. */
  consumedAt?: number
}

export { ATTACHMENT_UPLOAD_CHUNK_BYTES }

/** How long an upload nobody is touching survives. */
export const ATTACHMENT_UPLOAD_TTL_MS = 30 * 60 * 1000

/**
 * How long a committed-but-unreferenced object survives.
 *
 * Longer than the upload TTL on purpose: a client may commit every attachment
 * and only then discover it cannot send (offline, control lost, an approval in
 * the way). Collecting the bytes an hour later would turn a recoverable pause
 * into a silent loss of the file.
 */
export const ATTACHMENT_OBJECT_TTL_MS = 24 * 60 * 60 * 1000

/** Refusals a caller can act on, as opposed to a bug it can only report. */
export type AttachmentUploadRejection =
  | "attachment_unsupported_type"
  | "attachment_too_large"
  | "attachment_too_many"
  | "attachment_invalid_hash"
  | "attachment_not_found"
  | "attachment_offset_mismatch"
  | "attachment_size_mismatch"
  | "attachment_hash_mismatch"
  | "attachment_type_mismatch"
  | "attachment_already_committed"

export class AttachmentUploadError extends Error {
  constructor(readonly code: AttachmentUploadRejection) {
    super(code)
    this.name = "AttachmentUploadError"
  }
}

export interface BeginAttachmentUploadInput {
  sessionId: string
  deviceId: string
  name: string
  mediaType: string
  size: number
  hash: string
  /** Ceiling for one file. Defaults to the shared composer limit. */
  maxBytes?: number
  /** Ceiling for concurrently staged files per (session, device). */
  maxConcurrent?: number
  now?: number
}

export interface BeginAttachmentUploadResult {
  uploadId: string
  chunkSize: number
  /** Where the client should resume writing. Equal to `size` when complete. */
  resumeOffset: number
  /** True when this exact content is already committed — nothing left to send. */
  complete: boolean
  /** Present only when `complete`. */
  ref?: string
}

const HEX_64 = /^[0-9a-f]{64}$/

/**
 * Open (or rejoin) an upload.
 *
 * Idempotent on content: re-initing the same `(session, device, hash)` returns
 * the existing row rather than a second one. That is what makes a retry after
 * a dropped socket cheap, and what stops a client that re-stages the same
 * screenshot from paying for it twice.
 */
export async function beginAttachmentUpload(
  input: BeginAttachmentUploadInput
): Promise<BeginAttachmentUploadResult> {
  const now = input.now ?? Date.now()
  const maxBytes = input.maxBytes ?? COMPOSER_MAX_ATTACHMENT_BYTES
  const maxConcurrent = input.maxConcurrent ?? COMPOSER_MAX_ATTACHMENTS
  const hash = input.hash.toLowerCase()

  if (!HEX_64.test(hash)) throw new AttachmentUploadError("attachment_invalid_hash")
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > maxBytes) {
    throw new AttachmentUploadError("attachment_too_large")
  }
  if (!isSupportedAttachmentDescriptor({ name: input.name, mediaType: input.mediaType })) {
    throw new AttachmentUploadError("attachment_unsupported_type")
  }

  const db = getDb()
  await sweepAttachmentUploads(now)

  const existing = await db.sessionAttachmentUploads
    .where("[sessionId+deviceId]")
    .equals([input.sessionId, input.deviceId])
    .toArray()

  const match = existing.find(
    (row) => row.hash === hash && readStoredBytes(row.bytes) !== undefined
  )
  if (match) {
    // Touch it so rejoining an upload keeps it alive; a client that resumes
    // slowly must not race its own staging area to the collector.
    await db.sessionAttachmentUploads.update(match.uploadId, {
      updatedAt: now,
      expiresAt: now + ttlFor(match.status),
    })
    return {
      uploadId: match.uploadId,
      chunkSize: ATTACHMENT_UPLOAD_CHUNK_BYTES,
      resumeOffset: match.status === "committed" ? match.size : match.receivedBytes,
      complete: match.status === "committed",
      ...(match.status === "committed" ? { ref: uploadRef(match.uploadId) } : {}),
    }
  }

  // Only unconsumed rows count toward the ceiling: an attachment already sent
  // is no longer staged, and counting it would make the seventh message of a
  // conversation fail rather than the seventh file of a message.
  const staged = existing.filter((row) => row.consumedAt === undefined).length
  if (staged >= maxConcurrent) throw new AttachmentUploadError("attachment_too_many")

  const uploadId = `upl_${crypto.randomUUID()}`
  await db.sessionAttachmentUploads.add({
    uploadId,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    name: input.name,
    mediaType: input.mediaType,
    size: input.size,
    hash,
    receivedBytes: 0,
    bytes: new Uint8Array(0),
    status: "uploading",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ATTACHMENT_UPLOAD_TTL_MS,
  })
  return { uploadId, chunkSize: ATTACHMENT_UPLOAD_CHUNK_BYTES, resumeOffset: 0, complete: false }
}

function ttlFor(status: SessionAttachmentUploadStatus): number {
  return status === "committed" ? ATTACHMENT_OBJECT_TTL_MS : ATTACHMENT_UPLOAD_TTL_MS
}

/**
 * Read a row the caller is actually entitled to.
 *
 * A mismatched device is reported as "not found" rather than "forbidden": the
 * two answers together would let a device probe which upload ids exist.
 */
async function ownedRow(uploadId: string, deviceId: string): Promise<SessionAttachmentUploadRow> {
  const row = await getDb().sessionAttachmentUploads.get(uploadId)
  if (!row || row.deviceId !== deviceId) throw new AttachmentUploadError("attachment_not_found")
  return row
}

export interface AppendAttachmentChunkInput {
  uploadId: string
  deviceId: string
  /** Where this chunk starts. Must equal what the Host already holds. */
  offset: number
  bytes: Uint8Array
  now?: number
}

export interface AppendAttachmentChunkResult {
  receivedBytes: number
  /** True once the declared length has arrived; the client may commit. */
  complete: boolean
}

/**
 * Append one chunk.
 *
 * Strictly sequential. Accepting an arbitrary offset would mean tracking holes
 * and would let a client leave a file permanently half-written while still
 * holding the staging slot; refusing with `attachment_offset_mismatch` and the
 * true `receivedBytes` lets it re-sync in one round trip. A re-sent chunk that
 * lands entirely below the write head is a no-op rather than an error — a
 * retry after a response was lost in flight is the normal case, not a fault.
 */
export async function appendAttachmentChunk(
  input: AppendAttachmentChunkInput
): Promise<AppendAttachmentChunkResult> {
  const now = input.now ?? Date.now()
  const row = await ownedRow(input.uploadId, input.deviceId)
  if (row.status === "committed") throw new AttachmentUploadError("attachment_already_committed")
  if (input.offset + input.bytes.byteLength <= row.receivedBytes) {
    return { receivedBytes: row.receivedBytes, complete: row.receivedBytes === row.size }
  }
  if (input.offset !== row.receivedBytes) {
    throw new AttachmentUploadError("attachment_offset_mismatch")
  }
  const receivedBytes = row.receivedBytes + input.bytes.byteLength
  if (receivedBytes > row.size) throw new AttachmentUploadError("attachment_size_mismatch")

  const merged = new Uint8Array(receivedBytes)
  const held = readStoredBytes(row.bytes)
  if (held) merged.set(held.subarray(0, row.receivedBytes), 0)
  merged.set(input.bytes, row.receivedBytes)

  await getDb().sessionAttachmentUploads.update(input.uploadId, {
    bytes: merged,
    receivedBytes,
    updatedAt: now,
    expiresAt: now + ATTACHMENT_UPLOAD_TTL_MS,
  })
  return { receivedBytes, complete: receivedBytes === row.size }
}

export interface CommitAttachmentUploadResult {
  ref: string
  name: string
  /** The sniffed type, which may be narrower or simply different from the
   *  declared one. This is what the message carries. */
  mediaType: string
  size: number
  hash: string
}

/**
 * Seal an upload and mint its ref.
 *
 * Everything the client asserted at init is checked here against the bytes
 * that actually arrived — length, hash, and the media type, which is sniffed
 * from the magic bytes rather than believed. A label is a claim; the leading
 * bytes are evidence, and the model is about to be handed the file.
 */
export async function commitAttachmentUpload(input: {
  uploadId: string
  deviceId: string
  now?: number
}): Promise<CommitAttachmentUploadResult> {
  const now = input.now ?? Date.now()
  const row = await ownedRow(input.uploadId, input.deviceId)
  if (row.status === "committed") {
    return {
      ref: uploadRef(row.uploadId),
      name: row.name,
      mediaType: row.mediaType,
      size: row.size,
      hash: row.hash,
    }
  }
  const bytes = readStoredBytes(row.bytes)
  if (!bytes || bytes.byteLength !== row.size || row.receivedBytes !== row.size) {
    throw new AttachmentUploadError("attachment_size_mismatch")
  }
  if ((await sha256Bytes(bytes)) !== row.hash) {
    throw new AttachmentUploadError("attachment_hash_mismatch")
  }
  const mediaType = resolveMediaType(row, bytes)

  await getDb().sessionAttachmentUploads.update(row.uploadId, {
    status: "committed",
    mediaType,
    updatedAt: now,
    expiresAt: now + ATTACHMENT_OBJECT_TTL_MS,
  })
  return { ref: uploadRef(row.uploadId), name: row.name, mediaType, size: row.size, hash: row.hash }
}

/**
 * The type the message will carry.
 *
 * An image that sniffs as an image keeps the sniffed subtype — a JPEG labelled
 * `image/png` is a mislabel, not an attack, and the model needs the truth. A
 * declared image whose bytes are not an image at all is refused outright.
 * Documents are not sniffed: `lib/document` routes them by extension and most
 * of the formats it handles (csv, md, source code) have no magic bytes to
 * check, so there is nothing to compare a claim against.
 */
function resolveMediaType(row: SessionAttachmentUploadRow, bytes: Uint8Array): string {
  const sniffed = sniffImageMediaType(bytes)
  if (row.mediaType.startsWith("image/")) {
    if (!sniffed) throw new AttachmentUploadError("attachment_type_mismatch")
    return sniffed
  }
  // A document that is really an image is still a supported attachment, and
  // saying so lets it render instead of being parsed as text.
  return sniffed ?? row.mediaType
}

/**
 * Magic-byte image detection.
 *
 * Deliberately a short allow list rather than a general sniffer: these are the
 * formats `lib/chat/attachments/dispatch.ts` turns into an `image` block, and
 * anything else claiming to be an image has no path to the model anyway.
 */
export function sniffImageMediaType(bytes: Uint8Array): string | null {
  const starts = (...prefix: number[]) =>
    prefix.length <= bytes.byteLength && prefix.every((byte, index) => bytes[index] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg"
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif"
  if (starts(0x42, 0x4d)) return "image/bmp"
  // RIFF????WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes.byteLength >= 12) {
    const tag = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)
    if (tag === "WEBP") return "image/webp"
  }
  // ftyp box at offset 4: HEIC / AVIF share the ISO-BMFF container.
  if (bytes.byteLength >= 12) {
    const box = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!)
    if (box === "ftyp") {
      const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)
      if (brand.startsWith("hei") || brand.startsWith("mif")) return "image/heic"
      if (brand.startsWith("avi")) return "image/avif"
    }
  }
  if (starts(0x3c, 0x3f, 0x78, 0x6d, 0x6c) || starts(0x3c, 0x73, 0x76, 0x67)) {
    return "image/svg+xml"
  }
  return null
}

/** Drop an upload the client gave up on. Idempotent, and scoped to its owner. */
export async function abortAttachmentUpload(input: {
  uploadId: string
  deviceId: string
}): Promise<void> {
  const row = await getDb().sessionAttachmentUploads.get(input.uploadId)
  if (!row || row.deviceId !== input.deviceId) return
  await getDb().sessionAttachmentUploads.delete(input.uploadId)
}

/**
 * Resolve a ref a message is trying to carry.
 *
 * The re-check at dispatch, not a convenience read: the ref was minted at
 * commit time and the message may reach the runtime minutes later, by which
 * point the device may have been revoked or the ref may name a different
 * session entirely. Returns null rather than throwing so a caller can decide
 * whether a missing attachment fails the turn or merely trims it.
 */
export async function resolveAttachmentRef(
  ref: string,
  scope: { sessionId: string; deviceId?: string }
): Promise<SessionAttachmentUploadRow | null> {
  const uploadId = parseUploadRef(ref)
  if (!uploadId) return null
  const row = await getDb().sessionAttachmentUploads.get(uploadId)
  if (!row || row.status !== "committed") return null
  const bytes = readStoredBytes(row.bytes)
  if (!bytes) return null
  if (row.sessionId !== scope.sessionId) return null
  if (scope.deviceId !== undefined && row.deviceId !== scope.deviceId) return null
  return { ...row, bytes }
}

/**
 * Mark refs as spent once the runtime actually received the prompt.
 *
 * Two effects, both wanted: the row stops counting against the per-session
 * staging ceiling, and its bytes are released. The client's draft is what
 * survives, and it holds only metadata — a resend re-uploads, which is correct,
 * because the Host must not keep a copy of every file ever sent.
 */
export async function consumeAttachmentRefs(
  refs: readonly string[],
  now = Date.now()
): Promise<void> {
  const ids = refs.map(parseUploadRef).filter((id): id is string => id !== null)
  if (ids.length === 0) return
  const db = getDb()
  await Promise.all(
    ids.map((uploadId) =>
      db.sessionAttachmentUploads.update(uploadId, {
        consumedAt: now,
        bytes: undefined,
        updatedAt: now,
      })
    )
  )
}

/**
 * Collect abandoned uploads and orphaned objects.
 *
 * Runs off `beginAttachmentUpload` rather than a timer: the collector only
 * matters when something is being staged, and a Host that is idle has nothing
 * to reclaim. A consumed row is kept — it is metadata-only by then, and it is
 * the record that a ref was legitimately spent.
 */
export async function sweepAttachmentUploads(now = Date.now()): Promise<number> {
  const db = getDb()
  const expired = await db.sessionAttachmentUploads.where("expiresAt").below(now).toArray()
  const collectable = expired.filter((row) => row.consumedAt === undefined)
  if (collectable.length === 0) return 0
  await db.sessionAttachmentUploads.bulkDelete(collectable.map((row) => row.uploadId))
  return collectable.length
}

/** Drop every staged upload a device holds. Used on revoke / unpair. */
export async function releaseDeviceAttachmentUploads(deviceId: string): Promise<number> {
  const db = getDb()
  const ids = (await db.sessionAttachmentUploads
    .where("deviceId")
    .equals(deviceId)
    .primaryKeys()) as string[]
  if (ids.length === 0) return 0
  await db.sessionAttachmentUploads.bulkDelete(ids)
  return ids.length
}
