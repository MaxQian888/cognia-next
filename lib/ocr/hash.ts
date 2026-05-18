/**
 * SHA-256 over arbitrary blobs/strings/ArrayBuffers.
 *
 * Used as the file-identity half of the cache key (`sha256+provider+lang`).
 * Runs against `crypto.subtle` so it works in the browser, Tauri webview,
 * Capacitor webview, and Jest (`jest.setup.ts` polyfills webcrypto onto
 * `globalThis.crypto`).
 */

const HEX_CHARS = "0123456789abcdef"

function bytesToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf)
  let out = ""
  for (let i = 0; i < view.length; i++) {
    const b = view[i]!
    out += HEX_CHARS[b >>> 4]! + HEX_CHARS[b & 0x0f]!
  }
  return out
}

import { readBlobAsArrayBuffer } from "./blob-utils"

async function digest(data: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("sha256: Web Crypto unavailable")
  const buf = await subtle.digest("SHA-256", data)
  return bytesToHex(buf)
}

/** SHA-256 of a UTF-8 string, hex-encoded. */
export async function sha256String(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  return digest(bytes.buffer as ArrayBuffer)
}

/** SHA-256 of a Blob, hex-encoded. */
export async function sha256Blob(blob: Blob): Promise<string> {
  const buf = await readBlobAsArrayBuffer(blob)
  return digest(buf)
}

/** SHA-256 of a typed array / ArrayBuffer, hex-encoded. */
export async function sha256Bytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf =
    bytes instanceof Uint8Array
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : bytes
  return digest(buf as ArrayBuffer)
}

/**
 * SHA-256 of a base64 data URL's payload (just the bytes, not the metadata).
 * Returns null when the input isn't a data URL.
 */
export async function sha256DataUrl(dataUrl: string): Promise<string | null> {
  const match = /^data:[^;]+;base64,(.+)$/.exec(dataUrl)
  if (!match) return null
  const b64 = match[1]!
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary")
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return sha256Bytes(bytes)
}
