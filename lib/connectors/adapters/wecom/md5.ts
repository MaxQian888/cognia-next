/**
 * Minimal MD5 (RFC 1321) returning the lowercase hex digest.
 *
 * Hand-written because the repo carries no md5 dependency (checked
 * `package.json` + `lib/`; Web Crypto's `crypto.subtle.digest` does not
 * support MD5) and the WeCom media-upload init frame requires the MD5 of the
 * file bytes. NOT a security primitive — integrity checksum only, exactly as
 * the upload protocol demands.
 */

/** Per-round left-rotate amounts. */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const

/** K[i] = floor(|sin(i+1)| · 2^32) — the RFC's standard constant derivation. */
const K = Uint32Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32)
)

/** MD5 hex digest of `input` (strings are UTF-8 encoded first). */
export function md5Hex(input: Uint8Array | string): string {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input

  // Pad: append 0x80, zero-fill to 56 mod 64, then the 64-bit LE bit length.
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  // bitLen = data.length * 8 split into two 32-bit words (length ≤ 2^53 / 8).
  view.setUint32(padded.length - 8, (data.length << 3) >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(data.length / 0x20000000), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const m = new Uint32Array(16)
  for (let off = 0; off < padded.length; off += 64) {
    for (let j = 0; j < 16; j++) m[j] = view.getUint32(off + j * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      f = (f + a + K[i] + m[g]) | 0
      a = d
      d = c
      c = b
      b = (b + ((f << S[i]) | (f >>> (32 - S[i])))) | 0
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }

  return wordToHexLE(a0) + wordToHexLE(b0) + wordToHexLE(c0) + wordToHexLE(d0)
}

/** Hex-encode a 32-bit word in little-endian byte order (MD5 output order). */
function wordToHexLE(w: number): string {
  let out = ""
  for (let i = 0; i < 4; i++) out += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, "0")
  return out
}
