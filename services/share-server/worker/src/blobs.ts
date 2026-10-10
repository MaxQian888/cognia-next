// ADR-0222 file blobs: the pure rules the Worker enforces on a share's
// encrypted file chunks, mirroring `core/src/blobs.rs` and
// `core/src/ticket.rs`. `share-constants.json` and `ticket-vector.json` pin
// the two implementations together.

/** Plaintext bytes in every chunk but the last. */
export const BLOB_CHUNK_BYTES = 4 * 1024 * 1024
/** AES-GCM tag appended to each encrypted chunk. */
export const BLOB_CHUNK_OVERHEAD_BYTES = 16
/** Random bytes in a blob id; the wire form is unpadded base64url. */
export const BLOB_ID_BYTES = 16
/** Largest plaintext file one blob may carry. */
export const MAX_BLOB_BYTES = 512 * 1024 * 1024
/** Largest ciphertext total all of one share's blobs may store. */
export const MAX_SHARE_BLOB_BYTES = 2 * 1024 * 1024 * 1024
/** Most blobs (files) one share may carry. */
export const MAX_BLOBS_PER_SHARE = 200
/** How long a read ticket stays valid after the envelope read that issued it. */
export const READ_TICKET_TTL_SECONDS = 3600

export const MAX_CHUNK_CIPHERTEXT_BYTES = BLOB_CHUNK_BYTES + BLOB_CHUNK_OVERHEAD_BYTES
export const MAX_CHUNKS_PER_BLOB = Math.ceil(MAX_BLOB_BYTES / BLOB_CHUNK_BYTES)
export const BLOB_ID_LENGTH = Math.ceil((BLOB_ID_BYTES * 4) / 3)

const TICKET_DOMAIN = "cognia-share-read-ticket-v1"
const MINIMUM_TICKET_KEY_BYTES = 32

/** Whether `value` is a well-formed blob id (it becomes an R2 key segment). */
export function isValidBlobId(value: string): boolean {
  return value.length === BLOB_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(value)
}

/** Whether `value` is a well-formed share code that may name storage. */
export function isStorageSafeCode(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[A-Za-z0-9]+$/.test(value)
}

/** A canonical chunk index below the per-blob limit, or null. */
export function parseChunkIndex(value: string): number | null {
  if (!/^(0|[1-9][0-9]{0,8})$/.test(value)) return null
  const index = Number(value)
  return index < MAX_CHUNKS_PER_BLOB ? index : null
}

export type CommitError = "bad-chunk-count" | "missing-chunks" | "size-mismatch" | "bad-chunk-shape"

/**
 * Check that the chunks uploaded for a blob are exactly what the commit
 * declares. `chunks` maps index → ciphertext length. Every chunk but the
 * last must be a full encrypted chunk, so a reader's offsets line up.
 */
export function validateCommit(
  chunkCount: number,
  totalBytes: number,
  chunks: Record<string, number>
): CommitError | null {
  if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0 || chunkCount > MAX_CHUNKS_PER_BLOB) {
    return "bad-chunk-count"
  }
  const indexes = Object.keys(chunks)
  if (indexes.length !== chunkCount) return "missing-chunks"
  let sum = 0
  for (let index = 0; index < chunkCount; index++) {
    const len = chunks[String(index)]
    if (len === undefined) return "missing-chunks"
    const last = index === chunkCount - 1
    if (len <= BLOB_CHUNK_OVERHEAD_BYTES || len > MAX_CHUNK_CIPHERTEXT_BYTES) {
      return "bad-chunk-shape"
    }
    if (!last && len !== MAX_CHUNK_CIPHERTEXT_BYTES) return "bad-chunk-shape"
    sum += len
  }
  return sum === totalBytes ? null : "size-mismatch"
}

/** When a ticket issued at `now` stops working: one TTL, capped at the share's expiry. */
export function ticketExpiry(now: number, shareExpiresAt: number | undefined): number {
  const byTtl = now + READ_TICKET_TTL_SECONDS * 1000
  return shareExpiresAt === undefined ? byTtl : Math.min(byTtl, shareExpiresAt)
}

function hexToBytes(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 2 !== 0) return null
  const out = new Uint8Array(value.length / 2)
  for (let index = 0; index < out.length; index++) {
    const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
    if (Number.isNaN(byte)) return null
    out[index] = byte
  }
  return out
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * The HMAC key for read tickets, or null when `SHARE_TICKET_KEY` is unset or
 * unusable. Unlike the Rust server, a Worker cannot fall back to a random
 * per-process key — isolates come and go — so files are simply unavailable
 * until the operator sets one.
 */
export async function importTicketKey(hex: string | undefined): Promise<CryptoKey | null> {
  const bytes = hex ? hexToBytes(hex.trim()) : null
  if (!bytes || bytes.length < MINIMUM_TICKET_KEY_BYTES) return null
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])
}

function ticketMessage(code: string, expiresAt: number): Uint8Array {
  return new TextEncoder().encode(`${TICKET_DOMAIN}\n${code}\n${expiresAt}`)
}

/** `<expiresAtMs>.<base64url(HMAC-SHA256(key, message))>` */
export async function mintTicket(key: CryptoKey, code: string, expiresAt: number): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, ticketMessage(code, expiresAt))
  return `${expiresAt}.${bytesToBase64Url(new Uint8Array(signature))}`
}

/** Whether `ticket` was minted for `code` and is in date at `now`. Signature first. */
export async function verifyTicket(
  key: CryptoKey,
  ticket: string,
  code: string,
  now: number
): Promise<boolean> {
  const dot = ticket.indexOf(".")
  if (dot <= 0) return false
  const expiry = ticket.slice(0, dot)
  if (!/^[0-9]{1,16}$/.test(expiry)) return false
  const signature = base64UrlToBytes(ticket.slice(dot + 1))
  if (!signature || signature.length === 0) return false
  const expiresAt = Number(expiry)
  const valid = await crypto.subtle.verify("HMAC", key, signature, ticketMessage(code, expiresAt))
  return valid && now < expiresAt
}

/** R2 key prefix holding every chunk of a share's blobs. */
export function blobPrefix(code: string): string {
  return `share/${code}/blob/`
}

export function chunkKey(code: string, blobId: string, index: number): string {
  return `${blobPrefix(code)}${blobId}/${index}`
}
