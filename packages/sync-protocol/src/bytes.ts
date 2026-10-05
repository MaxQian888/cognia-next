/** Byte helpers shared by every protocol module. */

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export function utf8(value: string): Uint8Array {
  return encoder.encode(value)
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Equality that does not stop at the first differing byte. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const B64URL_INDEX = new Map([...B64URL].map((char, index) => [char, index]))

/** base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ""
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out +=
      B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!
  }
  return out
}

/**
 * Strict base64url decode: no padding, no foreign characters, and no
 * non-zero bits left over in the last character (so every byte string has
 * exactly one encoding, which matters for anything that is hashed).
 */
export function fromBase64Url(value: string): Uint8Array {
  if (value.length % 4 === 1) throw new Error("invalid base64url length")
  const out = new Uint8Array(Math.floor((value.length * 6) / 8))
  let buffer = 0
  let bits = 0
  let index = 0
  for (const char of value) {
    const digit = B64URL_INDEX.get(char)
    if (digit === undefined) throw new Error("invalid base64url character")
    buffer = (buffer << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[index++] = (buffer >> bits) & 0xff
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new Error("non-canonical base64url")
  }
  return out
}

/** Decode base64url and require an exact byte length. */
export function fromBase64UrlExact(value: unknown, length: number, what: string): Uint8Array {
  if (typeof value !== "string") throw new Error(`${what} must be a base64url string`)
  const bytes = fromBase64Url(value)
  if (bytes.length !== length) throw new Error(`${what} must be ${length} bytes`)
  return bytes
}

export function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}
