/**
 * base64url, on web primitives only.
 *
 * `lib/qr/pair-payload.ts` reaches for Node's `Buffer`, which the app gets
 * through a bundler polyfill. This package is imported by a browser extension
 * whose whole point is a minimal, auditable bundle, so it uses `atob`/`btoa`
 * and `TextEncoder`/`TextDecoder` — all of which exist unpolyfilled in the
 * extension, in the renderer, in jsdom, and in Node.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Encode raw bytes as unpadded base64url. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  // Chunked so a large payload cannot blow the argument limit of `apply`.
  let binary = ""
  const CHUNK = 0x8000
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

/** Decode unpadded (or padded) base64url back to bytes. */
export function base64UrlToBytes(value: string): Uint8Array {
  const padding = (4 - (value.length % 4)) % 4
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** Encode a UTF-8 string as unpadded base64url. */
export function textToBase64Url(value: string): string {
  return bytesToBase64Url(encoder.encode(value))
}

/** Decode unpadded base64url into a UTF-8 string. */
export function base64UrlToText(value: string): string {
  return decoder.decode(base64UrlToBytes(value))
}

/** UTF-8 byte length — the unit every limit in this contract is denominated in. */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length
}
