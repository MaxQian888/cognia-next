/**
 * iLink media decryption — AES-128-ECB + PKCS7.
 *
 * The platform encrypts CDN media with AES-128-ECB, which the browser's Web
 * Crypto does NOT support (only CBC/CTR/GCM). So this module ships a compact,
 * self-contained AES-128 inverse cipher (FIPS-197), verified against the
 * standard test vector in the co-located test. Inbound only — outbound media
 * (which would need ECB *encryption* + the CDN upload handshake) is not
 * supported in v1.
 *
 * Download goes through the Rust attachment cache (`fetch_attachment` →
 * `connectors_attachment_read`), NOT a renderer `fetch()` — the CDN host
 * sends no CORS headers, so a webview fetch is blocked before it starts.
 */

import { connectorsAttachmentRead } from "@/lib/connectors/tauri/commands"

// ── base64 helpers (browser + jsdom safe) ─────────────────────────────────
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// ── AES-128 (decrypt path) ─────────────────────────────────────────────────
// Forward S-box (canonical FIPS-197 table); inverse derived at load.
const SBOX = Uint8Array.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
])
const INV_SBOX = (() => {
  const inv = new Uint8Array(256)
  for (let i = 0; i < 256; i++) inv[SBOX[i]] = i
  return inv
})()
const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]

function gmul(a: number, b: number): number {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1b
    b >>= 1
  }
  return p & 0xff
}

/** Expand a 16-byte key into 176 bytes (11 round keys), column-major words. */
function keyExpansion(key: Uint8Array): Uint8Array {
  const w = new Uint8Array(176)
  w.set(key.subarray(0, 16))
  for (let i = 4; i < 44; i++) {
    const t = [w[(i - 1) * 4], w[(i - 1) * 4 + 1], w[(i - 1) * 4 + 2], w[(i - 1) * 4 + 3]]
    if (i % 4 === 0) {
      // RotWord
      const tmp = t[0]
      t[0] = t[1]
      t[1] = t[2]
      t[2] = t[3]
      t[3] = tmp
      // SubWord
      t[0] = SBOX[t[0]]
      t[1] = SBOX[t[1]]
      t[2] = SBOX[t[2]]
      t[3] = SBOX[t[3]]
      t[0] ^= RCON[i / 4 - 1]
    }
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - 4) * 4 + j] ^ t[j]
  }
  return w
}

function invShiftRows(s: Uint8Array): void {
  for (let r = 1; r < 4; r++) {
    const row = [s[r], s[r + 4], s[r + 8], s[r + 12]]
    for (let c = 0; c < 4; c++) s[r + 4 * c] = row[(c - r + 4) % 4]
  }
}

function invMixColumns(s: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const a0 = s[4 * c],
      a1 = s[4 * c + 1],
      a2 = s[4 * c + 2],
      a3 = s[4 * c + 3]
    s[4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9)
    s[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13)
    s[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11)
    s[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14)
  }
}

/** AES-128 inverse cipher on one 16-byte block. */
function decryptBlock(ct: Uint8Array, w: Uint8Array): Uint8Array {
  const s = ct.slice(0, 16)
  for (let i = 0; i < 16; i++) s[i] ^= w[160 + i] // AddRoundKey(10)
  for (let round = 9; round >= 1; round--) {
    invShiftRows(s)
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]]
    for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i]
    invMixColumns(s)
  }
  invShiftRows(s)
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]]
  for (let i = 0; i < 16; i++) s[i] ^= w[i] // AddRoundKey(0)
  return s
}

/** Decrypt one raw 16-byte AES-128 block (no mode/padding). For test vectors. */
export function aes128DecryptBlock(block: Uint8Array, key: Uint8Array): Uint8Array {
  if (block.length !== 16 || key.length !== 16) throw new Error("aes128: block + key must be 16B")
  return decryptBlock(block, keyExpansion(key))
}

/**
 * Normalise the iLink AES key. The base64 payload decodes to either 16 raw
 * bytes, or a 32-char ASCII hex string — handle both.
 */
function normalizeKey(aesKeyBase64: string): Uint8Array {
  const decoded = base64ToBytes(aesKeyBase64)
  if (decoded.length === 16) return decoded
  if (decoded.length === 32) {
    const hex = new TextDecoder().decode(decoded)
    if (/^[0-9a-fA-F]{32}$/.test(hex)) {
      const out = new Uint8Array(16)
      for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      return out
    }
  }
  throw new Error(`ilink aes key has unexpected length ${decoded.length}`)
}

function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data
  const pad = data[data.length - 1]
  if (pad < 1 || pad > 16 || pad > data.length) return data // tolerate non-padded
  return data.subarray(0, data.length - pad)
}

/** Decrypt AES-128-ECB ciphertext (PKCS7) given the base64 key. */
export function decryptIlinkMedia(
  ciphertext: ArrayBuffer | Uint8Array,
  aesKeyBase64: string
): Uint8Array {
  const key = normalizeKey(aesKeyBase64)
  const w = keyExpansion(key)
  const ct = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext)
  if (ct.length % 16 !== 0) throw new Error("ilink media ciphertext not a multiple of 16")
  const out = new Uint8Array(ct.length)
  for (let off = 0; off < ct.length; off += 16) {
    out.set(decryptBlock(ct.subarray(off, off + 16), w), off)
  }
  return pkcs7Unpad(out)
}

/** Cap on cached-attachment reads for inline images. */
export const ILINK_MEDIA_MAX_BYTES = 20 * 1024 * 1024

export interface FetchIlinkMediaViaTauriInput {
  adapterId: string
  /** Encrypted CDN download URL — doubles as the attachment-cache remoteRef. */
  url: string
  /** Base64 AES-128 key; omitted ⇒ the payload is plaintext. */
  aesKeyBase64?: string
  /**
   * `ctx.tauri.fetchAttachment` — downloads the CDN bytes in Rust and caches
   * them locally (the renderer cannot fetch the CDN URL: CORS-blocked).
   */
  fetchAttachment: (adapterId: string, remoteRef: string) => Promise<unknown>
  /** Test seam — defaults to the `connectors_attachment_read` wrapper. */
  readAttachment?: typeof connectorsAttachmentRead
}

/**
 * Download an encrypted CDN payload through the Rust attachment cache and
 * decrypt it locally. Bytes flow Rust `fetch_attachment` → encrypted cache →
 * `connectors_attachment_read` (base64) → AES-128-ECB decrypt. Throws on
 * download, cache-read, or decrypt failure.
 */
export async function fetchAndDecryptIlinkMediaViaTauri(
  input: FetchIlinkMediaViaTauriInput
): Promise<Uint8Array> {
  const { adapterId, url, aesKeyBase64, fetchAttachment } = input
  const readAttachment = input.readAttachment ?? connectorsAttachmentRead
  await fetchAttachment(adapterId, url)
  const b64 = await readAttachment(adapterId, url, ILINK_MEDIA_MAX_BYTES)
  if (b64 === null) throw new Error("ilink media not readable from the attachment cache")
  const bytes = base64ToBytes(b64)
  if (!aesKeyBase64) return bytes
  return decryptIlinkMedia(bytes, aesKeyBase64)
}
