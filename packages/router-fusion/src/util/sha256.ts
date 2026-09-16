/**
 * Synchronous SHA-256 over UTF-8 text.
 *
 * The package stays free of `node:crypto` (the static export and the mobile
 * bundle stub Node built-ins) and WebCrypto's `subtle.digest` is async, which
 * would force config compilation, idempotency hashing and action hashing to
 * become async for no benefit. Inputs here are small canonical JSON strings.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8
  const paddedLength = Math.ceil((data.length + 9) / 64) * 64
  const buffer = new Uint8Array(paddedLength)
  buffer.set(data)
  buffer[data.length] = 0x80
  const view = new DataView(buffer.buffer)
  // Length in bits as a 64-bit big-endian integer (inputs stay far below 2^53).
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const w = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = w[i - 15]
      const s1 = w[i - 2]
      const r15 = ((s0 >>> 7) | (s0 << 25)) ^ ((s0 >>> 18) | (s0 << 14)) ^ (s0 >>> 3)
      const r2 = ((s1 >>> 17) | (s1 << 15)) ^ ((s1 >>> 19) | (s1 << 13)) ^ (s1 >>> 10)
      w[i] = (r2 + w[i - 7] + r15 + w[i - 16]) | 0
    }
    let a = h[0]
    let b = h[1]
    let c = h[2]
    let d = h[3]
    let e = h[4]
    let f = h[5]
    let g = h[6]
    let hh = h[7]
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + K[i] + w[i]) | 0
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0
    h[5] = (h[5] + f) | 0
    h[6] = (h[6] + g) | 0
    h[7] = (h[7] + hh) | 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false)
  return out
}

export function sha256Hex(text: string): string {
  return toHex(sha256Bytes(utf8(text)))
}

/**
 * A deterministic UUID (RFC 9562 version 8) for a name: the first 122 bits of
 * its SHA-256 with the version and variant bits set. The contracts type every
 * artifact id as a UUID; content-addressed ids stay content-addressed and still
 * validate.
 */
export function uuidFromName(name: string): string {
  const bytes = sha256Bytes(new TextEncoder().encode(name)).slice(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = toHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

/**
 * HMAC-SHA256 (RFC 2104) — for cache keys that must not expose or be
 * guessable from their input (DESIGN §7.1, §12.4). An HMAC is not
 * anonymization: the key material and the digests stay tenant-private.
 *
 * Reserved for the LLM classifier's result cache (ADR-0188 D18, B5), whose key
 * must be computed synchronously on the routing path; nothing calls it yet.
 * The Run API's read tokens use WebCrypto HMAC instead (`artifact-tokens.ts`).
 */
export function hmacSha256Hex(key: string, message: string): string {
  const blockSize = 64
  let keyBytes = utf8(key)
  if (keyBytes.length > blockSize) keyBytes = sha256Bytes(keyBytes)
  const padded = new Uint8Array(blockSize)
  padded.set(keyBytes)
  const inner = new Uint8Array(blockSize)
  const outer = new Uint8Array(blockSize)
  for (let i = 0; i < blockSize; i++) {
    inner[i] = padded[i] ^ 0x36
    outer[i] = padded[i] ^ 0x5c
  }
  const messageBytes = utf8(message)
  const innerInput = new Uint8Array(blockSize + messageBytes.length)
  innerInput.set(inner)
  innerInput.set(messageBytes, blockSize)
  const innerHash = sha256Bytes(innerInput)
  const outerInput = new Uint8Array(blockSize + innerHash.length)
  outerInput.set(outer)
  outerInput.set(innerHash, blockSize)
  return toHex(sha256Bytes(outerInput))
}

/**
 * Canonical JSON: object keys sorted, no insignificant whitespace, `undefined`
 * members dropped. Strings are NOT normalized — two requests that differ only
 * in whitespace inside message text hash differently (DESIGN §15.1).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("canonical JSON cannot encode a non-finite number")
    }
    if (value === undefined)
      throw new TypeError("canonical JSON cannot encode undefined at the top level")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
