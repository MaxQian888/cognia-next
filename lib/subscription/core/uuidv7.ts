// Minimal UUIDv7 generator. RFC 9562 §5.7.
//
// Format: `<unix-ms (48 bits)><ver 0b0111><rand_a (12 bits)><var 0b10><rand_b (62 bits)>`
//
// We don't pull in the `uuid` npm package on the TS side because:
//   1. It would add ~30KB to the renderer bundle for a single function.
//   2. The Rust side already mints UUIDv7s via `uuid::Uuid::now_v7()` —
//      the renderer only generates ids on the rare paths where a new account
//      is materialized client-first (e.g. CC-Switch encrypted import where
//      we don't want to round-trip through Rust just to assign an id).

const HEX = "0123456789abcdef"

function toHex(byte: number): string {
  return HEX[(byte >> 4) & 0xf] + HEX[byte & 0xf]
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n)
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(buf)
    return buf
  }
  // Fallback for non-crypto-aware environments (jsdom in older jest, etc.).
  // Math.random is NOT cryptographically secure — UUIDv7's uniqueness budget
  // is large enough that this is acceptable for non-secret identifiers.
  for (let i = 0; i < n; i += 1) {
    buf[i] = Math.floor(Math.random() * 256)
  }
  return buf
}

/**
 * Generate a UUIDv7 string. Monotonically ordered by `Date.now()` and unique
 * to ~2^74 random bits — collision probability is negligible.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error(`uuidv7 requires non-negative finite nowMs, got ${nowMs}`)
  }
  const ts = Math.floor(nowMs)

  // 48 bits of timestamp. JS bitwise operators are 32-bit, so we split into
  // upper-16 + lower-32 to avoid clipping.
  const tsHi = Math.floor(ts / 2 ** 32) & 0xffff
  const tsLo = ts >>> 0

  // 10 random bytes for rand_a (12 bits) + rand_b (62 bits). We fill all
  // 10 bytes and then overwrite the leading nibbles with the version/variant.
  const rand = randomBytes(10)
  // Set version (0b0111) in the high nibble of byte 0.
  rand[0] = (rand[0] & 0x0f) | 0x70
  // Set variant (0b10) in the high two bits of byte 2.
  rand[2] = (rand[2] & 0x3f) | 0x80

  // Big-endian 48-bit timestamp:
  //   byte 0 = (ts >> 40) & 0xff
  //   byte 1 = (ts >> 32) & 0xff
  //   byte 2 = (ts >> 24) & 0xff
  //   byte 3 = (ts >> 16) & 0xff
  //   byte 4 = (ts >>  8) & 0xff
  //   byte 5 = (ts      ) & 0xff
  const b0 = (tsHi >>> 8) & 0xff
  const b1 = tsHi & 0xff
  const b2 = (tsLo >>> 24) & 0xff
  const b3 = (tsLo >>> 16) & 0xff
  const b4 = (tsLo >>> 8) & 0xff
  const b5 = tsLo & 0xff

  // Bytes 6..15 come from `rand` (version/variant already stamped).
  const b6 = rand[0]
  const b7 = rand[1]
  const b8 = rand[2]
  const b9 = rand[3]
  const b10 = rand[4]
  const b11 = rand[5]
  const b12 = rand[6]
  const b13 = rand[7]
  const b14 = rand[8]
  const b15 = rand[9]

  return (
    toHex(b0) +
    toHex(b1) +
    toHex(b2) +
    toHex(b3) +
    "-" +
    toHex(b4) +
    toHex(b5) +
    "-" +
    toHex(b6) +
    toHex(b7) +
    "-" +
    toHex(b8) +
    toHex(b9) +
    "-" +
    toHex(b10) +
    toHex(b11) +
    toHex(b12) +
    toHex(b13) +
    toHex(b14) +
    toHex(b15)
  )
}

/**
 * Predicate — does `s` look like a UUIDv7 emitted by `uuidv7()`? Checks
 * formatting + version + variant. Doesn't validate timestamp ordering.
 */
export function isUuidV7(s: string): boolean {
  if (typeof s !== "string" || s.length !== 36) return false
  if (s[8] !== "-" || s[13] !== "-" || s[18] !== "-" || s[23] !== "-") return false
  // Version nibble at position 14 (the 7th hex byte's high nibble).
  if (s[14] !== "7") return false
  // Variant high bits at position 19 — must be 8, 9, a, or b.
  const variantNibble = s[19].toLowerCase()
  if (
    variantNibble !== "8" &&
    variantNibble !== "9" &&
    variantNibble !== "a" &&
    variantNibble !== "b"
  ) {
    return false
  }
  // All other positions are lowercase hex.
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) continue
    const ch = s.charCodeAt(i)
    const isDigit = ch >= 48 && ch <= 57
    const isHex = ch >= 97 && ch <= 102
    if (!isDigit && !isHex) return false
  }
  return true
}
