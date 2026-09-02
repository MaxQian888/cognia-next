/**
 * The `bytesRef` shape of the operation contract (`bytes`, `base64`,
 * `dataUrl`, `url`, `mimeType`) converted to and from what the SDK, a
 * multipart upload, or a caller needs. Pure.
 */

import type { z } from "zod"
import type { imagesGenerateOutput } from "@cognia/provider-types"

import { ProviderOperationFailureError } from "../failure"

/** The contract's `bytesRef`, taken from a schema that embeds it. */
export type BytesRef = z.infer<typeof imagesGenerateOutput>["images"][number]

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(base64, "base64"))
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function parseDataUrl(dataUrl: string): { mimeType?: string; base64: string } {
  const match = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match || !match[2]) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: "only base64 data URLs are accepted",
    })
  }
  return { ...(match[1] ? { mimeType: match[1] } : {}), base64: match[3] }
}

/** Inline bytes of a ref. A `url`-only ref has none and is refused. */
export function bytesOf(ref: BytesRef): Uint8Array {
  if (ref.bytes) return ref.bytes
  if (ref.base64) return base64ToBytes(ref.base64)
  if (ref.dataUrl) return base64ToBytes(parseDataUrl(ref.dataUrl).base64)
  throw new ProviderOperationFailureError({
    code: "schema",
    retryable: false,
    message: "content carries no inline bytes (bytes, base64 or dataUrl)",
  })
}

/** What the AI SDK accepts as `DataContent`: bytes, a base64 string, a data URL or a URL. */
export function dataContentOf(ref: BytesRef): Uint8Array | string {
  if (ref.bytes) return ref.bytes
  if (ref.dataUrl) return ref.dataUrl
  if (ref.base64) return ref.base64
  if (ref.url) return ref.url
  throw new ProviderOperationFailureError({
    code: "schema",
    retryable: false,
    message: "content is empty",
  })
}

export function mimeTypeOf(ref: BytesRef, fallback = "application/octet-stream"): string {
  if (ref.mimeType) return ref.mimeType
  if (ref.dataUrl) return parseDataUrl(ref.dataUrl).mimeType ?? fallback
  return fallback
}

/** A `Blob` for a multipart upload. */
export function blobOf(ref: BytesRef): Blob {
  const bytes = bytesOf(ref)
  return new Blob([bytes as BlobPart], { type: mimeTypeOf(ref) })
}

/** A ref for bytes a vendor returned. Carries base64 so it serialises over RPC. */
export function bytesRefOf(bytes: Uint8Array, mimeType?: string): BytesRef {
  // A fresh copy: the contract types the bytes over a plain ArrayBuffer.
  const copy = new Uint8Array(bytes)
  return { bytes: copy, base64: bytesToBase64(copy), ...(mimeType ? { mimeType } : {}) }
}

/** A ref from an SDK generated file (`base64` + `mediaType`). */
export function bytesRefOfGenerated(file: { base64: string; mediaType: string }): BytesRef {
  return { base64: file.base64, mimeType: file.mediaType }
}
