// Base64 / base64url codecs for the share subsystem.
//
// `lib/data/crypto.ts` keeps its own base64 helpers module-private, and we also
// need the URL-safe (unpadded) variant for the key that rides in the URL
// `#fragment`. These are tiny and pure, so we keep a self-contained, tested copy
// here rather than widening the data-crypto API surface.

export function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  return Buffer.from(bytes).toString("base64")
}

export function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

/** URL-safe base64 without padding — safe to drop into a URL `#fragment`. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const remainder = padded.length % 4
  return decodeBase64(remainder === 0 ? padded : padded + "=".repeat(4 - remainder))
}
