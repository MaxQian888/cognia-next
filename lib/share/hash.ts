// SHA-256 helper, self-contained so `lib/share` has no dependency on the backup
// crypto module (whose `./types` drags in app-wide types). Keeping the share
// subsystem a clean leaf lets the standalone viewer import it without pulling
// the rest of the app into its bundle / type graph. Web Crypto only.

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is required but not available in this runtime")
  }
  return subtle
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Hex-encoded SHA-256 of a UTF-8 string. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await getSubtle().digest("SHA-256", toArrayBuffer(new TextEncoder().encode(value)))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
