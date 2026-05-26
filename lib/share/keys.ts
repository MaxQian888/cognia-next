// The per-share content key. 32 random bytes (AES-256), generated client-side,
// encoded URL-safe for the `#fragment`. The key is never uploaded — it is the
// whole basis of the zero-knowledge property.

import { encodeBase64Url, decodeBase64Url } from "./encoding"

export const SHARE_KEY_BYTES = 32

/** Cryptographically-random 256-bit content key. */
export function generateShareKey(): Uint8Array {
  const random = globalThis.crypto?.getRandomValues
  if (!random) throw new Error("Secure random source is not available in this runtime")
  return globalThis.crypto.getRandomValues(new Uint8Array(SHARE_KEY_BYTES))
}

export function encodeShareKey(key: Uint8Array): string {
  return encodeBase64Url(key)
}

export function decodeShareKey(value: string): Uint8Array {
  const bytes = decodeBase64Url(value)
  if (bytes.length !== SHARE_KEY_BYTES) {
    throw new Error(
      `Invalid share key length: expected ${SHARE_KEY_BYTES} bytes, got ${bytes.length}`
    )
  }
  return bytes
}
