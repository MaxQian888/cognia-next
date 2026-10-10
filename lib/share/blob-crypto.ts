// Encryption for the files a share carries (ADR-0222 §6.1).
//
// A file travels as a blob of fixed-size chunks the share server stores but
// cannot read. Every key derives from the share's key material
// (`ShareKeyMaterial` in `./crypto`), which never leaves the URL fragment and
// the passphrase:
//
//   file key  = HKDF-SHA256(ikm = material, salt = blobId bytes,
//                           info = "cognia-share-blob-v1")       → AES-256-GCM
//   chunk IV  = ivPrefix (8 random bytes, per blob) ‖ uint32BE(index)
//   chunk AAD = utf8(code) ‖ 0x00 ‖ utf8(blobId) ‖ 0x00
//               ‖ uint32BE(index) ‖ uint32BE(chunkCount)
//
// The AAD binds a chunk to its position, its blob's length and its share, so
// a server that reorders, drops, truncates or splices chunks across shares
// fails authentication; the per-file plaintext SHA-256 in the manifest is
// checked after reassembly on top. The IV is never sent with a chunk — the
// server sizes every middle chunk at exactly `BLOB_CHUNK_BYTES + 16` — so the
// prefix rides in the encrypted manifest instead.
//
// Web Crypto only, like the rest of `lib/share`: the viewer runs this in the
// recipient's browser.

import { decodeBase64, decodeBase64Url, encodeBase64, encodeBase64Url } from "./encoding"

/** Plaintext bytes in every chunk but the last (`share-constants.json`). */
export const SHARE_BLOB_CHUNK_BYTES = 4 * 1024 * 1024
/** The AES-GCM tag each encrypted chunk adds. */
export const SHARE_BLOB_CHUNK_OVERHEAD_BYTES = 16
/** Random bytes in a blob id. */
export const SHARE_BLOB_ID_BYTES = 16
/** Largest file one share may carry. */
export const SHARE_MAX_BLOB_BYTES = 512 * 1024 * 1024
/** Largest ciphertext total all of one share's files may store. */
export const SHARE_MAX_TOTAL_BLOB_BYTES = 2 * 1024 * 1024 * 1024
/** Most files one share may carry. */
export const SHARE_MAX_BLOBS = 200
/** How long a read ticket works after the envelope read that issued it. */
export const SHARE_READ_TICKET_TTL_SECONDS = 3600

/** Random bytes in a blob's IV prefix. */
export const SHARE_BLOB_IV_PREFIX_BYTES = 8

const HKDF_INFO = new TextEncoder().encode("cognia-share-blob-v1")

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is required but not available in this runtime")
  }
  return subtle
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes) as BufferSource
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function randomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random source is not available in this runtime")
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

/** A fresh blob id. */
export function newShareBlobId(): string {
  return encodeBase64Url(randomBytes(SHARE_BLOB_ID_BYTES))
}

/** A fresh per-blob IV prefix, base64. */
export function newShareBlobIvPrefix(): string {
  return encodeBase64(randomBytes(SHARE_BLOB_IV_PREFIX_BYTES))
}

/** Whether `value` is a well-formed blob id — it becomes a URL path segment. */
export function isShareBlobId(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value)
}

/** Chunks a file of `size` plaintext bytes is cut into; zero for an empty file. */
export function shareBlobChunkCount(size: number): number {
  return Math.ceil(size / SHARE_BLOB_CHUNK_BYTES)
}

/** Plaintext bytes in chunk `index` of a file of `size` bytes. */
export function shareBlobChunkLength(size: number, index: number): number {
  return Math.min(SHARE_BLOB_CHUNK_BYTES, size - index * SHARE_BLOB_CHUNK_BYTES)
}

/** Ciphertext bytes a file of `size` plaintext bytes stores on the server. */
export function shareBlobStoredBytes(size: number): number {
  return size + shareBlobChunkCount(size) * SHARE_BLOB_CHUNK_OVERHEAD_BYTES
}

/** Where one chunk sits; everything its AAD and IV bind. */
export interface ShareBlobChunkRef {
  code: string
  blobId: string
  /** Base64 of the blob's IV prefix. */
  ivPrefix: string
  index: number
  chunkCount: number
}

function uint32BE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`Not a uint32: ${value}`)
  }
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

/** The 12-byte IV of one chunk. */
export function shareBlobChunkIv(ivPrefix: string, index: number): Uint8Array {
  const prefix = decodeBase64(ivPrefix)
  if (prefix.length !== SHARE_BLOB_IV_PREFIX_BYTES) {
    throw new Error(`Invalid blob IV prefix: expected ${SHARE_BLOB_IV_PREFIX_BYTES} bytes`)
  }
  const iv = new Uint8Array(12)
  iv.set(prefix, 0)
  iv.set(uint32BE(index), SHARE_BLOB_IV_PREFIX_BYTES)
  return iv
}

/** The additional authenticated data of one chunk. */
export function shareBlobChunkAad(ref: Omit<ShareBlobChunkRef, "ivPrefix">): Uint8Array {
  const encoder = new TextEncoder()
  const code = encoder.encode(ref.code)
  const blobId = encoder.encode(ref.blobId)
  const out = new Uint8Array(code.length + 1 + blobId.length + 1 + 8)
  out.set(code, 0)
  out.set(blobId, code.length + 1)
  const tail = code.length + 1 + blobId.length + 1
  out.set(uint32BE(ref.index), tail)
  out.set(uint32BE(ref.chunkCount), tail + 4)
  return out
}

/** The AES key for one file of a share. */
export async function deriveShareBlobKey(material: Uint8Array, blobId: string): Promise<CryptoKey> {
  if (!isShareBlobId(blobId)) throw new Error("Invalid share blob id")
  const subtle = getSubtle()
  const ikm = await subtle.importKey("raw", toBufferSource(material), "HKDF", false, ["deriveKey"])
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBufferSource(decodeBase64Url(blobId)),
      info: toBufferSource(HKDF_INFO),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

function checkPosition(ref: ShareBlobChunkRef): void {
  if (ref.chunkCount < 1 || ref.index >= ref.chunkCount) {
    throw new RangeError(`Chunk ${ref.index} is outside a ${ref.chunkCount}-chunk blob`)
  }
}

/** Encrypt one plaintext chunk; the result is what the server stores. */
export async function encryptShareBlobChunk(
  key: CryptoKey,
  ref: ShareBlobChunkRef,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  checkPosition(ref)
  if (plaintext.length === 0 || plaintext.length > SHARE_BLOB_CHUNK_BYTES) {
    throw new RangeError(`A chunk carries 1..${SHARE_BLOB_CHUNK_BYTES} bytes`)
  }
  const ciphertext = await getSubtle().encrypt(
    {
      name: "AES-GCM",
      iv: toBufferSource(shareBlobChunkIv(ref.ivPrefix, ref.index)),
      additionalData: toBufferSource(shareBlobChunkAad(ref)),
    },
    key,
    toBufferSource(plaintext)
  )
  return new Uint8Array(ciphertext)
}

/**
 * Decrypt one stored chunk. Rejects (WebCrypto `OperationError`) when the
 * chunk was altered, moved, taken from another blob or share, or decrypted
 * with the wrong key.
 */
export async function decryptShareBlobChunk(
  key: CryptoKey,
  ref: ShareBlobChunkRef,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  checkPosition(ref)
  const plaintext = await getSubtle().decrypt(
    {
      name: "AES-GCM",
      iv: toBufferSource(shareBlobChunkIv(ref.ivPrefix, ref.index)),
      additionalData: toBufferSource(shareBlobChunkAad(ref)),
    },
    key,
    toBufferSource(ciphertext)
  )
  return new Uint8Array(plaintext)
}
