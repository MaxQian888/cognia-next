/**
 * Per-probe request signing for `POST /api/status/v1/observations`.
 *
 * The external Node probe signs and the status Worker verifies with the same
 * canonical input, built here so the two cannot drift. WebCrypto only
 * (`globalThis.crypto.subtle`), which Node, Workers and browsers all provide;
 * no Node `Buffer` and no `node:crypto` import, so the file bundles into the
 * Worker unchanged.
 *
 * Canonical input, newline-delimited UTF-8:
 *
 *   cognia-status-probe-v1
 *   <HTTP METHOD, upper case>
 *   <exact path, no query or fragment>
 *   <request timestamp, integer ms since epoch>
 *   <run id>
 *   <lowercase hex SHA-256 of the raw body bytes>
 *
 * The signature is base64url(HMAC-SHA-256(secret, input)). The key ID picks a
 * registered secret on the server; the server, not the payload, decides which
 * probe that key may speak for.
 */

import { SIGNATURE_WINDOW_MS } from "./contract"

export const PROBE_SIGNATURE_SCHEME = "cognia-status-probe-v1"

export const PROBE_HEADERS = {
  keyId: "x-cognia-probe-key",
  timestamp: "x-cognia-probe-timestamp",
  runId: "x-cognia-probe-run",
  signature: "x-cognia-probe-signature",
} as const

/** Minimum secret length in bytes. */
export const MIN_PROBE_SECRET_BYTES = 32

const encoder = new TextEncoder()

export function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4)
  try {
    const binary = atob(withPadding)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

/** Copy into a fresh ArrayBuffer-backed view, as WebCrypto's types require. */
function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return copy
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer(bytes))
  return bytesToHex(new Uint8Array(digest))
}

/**
 * A path the signature can name unambiguously: absolute, no query, fragment,
 * empty or dot segments, percent-encoding or backslashes.
 */
export function isCanonicalSignedPath(path: string): boolean {
  if (!path.startsWith("/") || path.length > 256) return false
  if (/[?#%\\\s]/.test(path)) return false
  const segments = path.split("/").slice(1)
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

export interface ProbeSigningFields {
  method: string
  path: string
  timestampMs: number
  runId: string
  bodySha256Hex: string
}

export function canonicalProbeSigningInput(fields: ProbeSigningFields): string {
  if (!isCanonicalSignedPath(fields.path)) throw new Error("non-canonical signed path")
  if (!Number.isInteger(fields.timestampMs) || fields.timestampMs < 0) {
    throw new Error("invalid signing timestamp")
  }
  if (/[\n\r]/.test(fields.runId) || fields.runId.length === 0) throw new Error("invalid run id")
  if (!/^[0-9a-f]{64}$/.test(fields.bodySha256Hex)) throw new Error("invalid body digest")
  return [
    PROBE_SIGNATURE_SCHEME,
    fields.method.toUpperCase(),
    fields.path,
    String(fields.timestampMs),
    fields.runId,
    fields.bodySha256Hex,
  ].join("\n")
}

async function hmacKey(secret: Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (secret.byteLength < MIN_PROBE_SECRET_BYTES) throw new Error("probe secret too short")
  return crypto.subtle.importKey("raw", buffer(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ])
}

export interface SignProbeRequestInput {
  keyId: string
  secret: Uint8Array
  method: string
  path: string
  runId: string
  body: Uint8Array
  nowMs: number
}

/** Headers to attach to the ingestion request. */
export async function signProbeRequest(
  input: SignProbeRequestInput
): Promise<Record<string, string>> {
  const bodySha256Hex = await sha256Hex(input.body)
  const message = canonicalProbeSigningInput({
    method: input.method,
    path: input.path,
    timestampMs: input.nowMs,
    runId: input.runId,
    bodySha256Hex,
  })
  const key = await hmacKey(input.secret, "sign")
  const signature = await crypto.subtle.sign("HMAC", key, buffer(encoder.encode(message)))
  return {
    [PROBE_HEADERS.keyId]: input.keyId,
    [PROBE_HEADERS.timestamp]: String(input.nowMs),
    [PROBE_HEADERS.runId]: input.runId,
    [PROBE_HEADERS.signature]: bytesToBase64Url(new Uint8Array(signature)),
  }
}

export type ProbeSignatureVerdict =
  | { ok: true; keyId: string; runId: string; timestampMs: number }
  | {
      ok: false
      reason:
        | "missing_header"
        | "bad_timestamp"
        | "outside_window"
        | "bad_path"
        | "bad_signature"
        | "unknown_key"
    }

export interface VerifyProbeRequestInput {
  headers: { get(name: string): string | null }
  method: string
  path: string
  body: Uint8Array
  nowMs: number
  /** Resolve a key ID to its secret, or null when unknown / revoked / expired. */
  resolveSecret: (keyId: string) => Promise<Uint8Array | null> | Uint8Array | null
}

/**
 * Verify a signed ingestion request. HMAC comparison goes through
 * `crypto.subtle.verify`, which compares in constant time.
 */
export async function verifyProbeRequest(
  input: VerifyProbeRequestInput
): Promise<ProbeSignatureVerdict> {
  const keyId = input.headers.get(PROBE_HEADERS.keyId)
  const timestamp = input.headers.get(PROBE_HEADERS.timestamp)
  const runId = input.headers.get(PROBE_HEADERS.runId)
  const signature = input.headers.get(PROBE_HEADERS.signature)
  if (!keyId || !timestamp || !runId || !signature) return { ok: false, reason: "missing_header" }
  if (!/^\d{1,16}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" }
  const timestampMs = Number(timestamp)
  if (Math.abs(input.nowMs - timestampMs) > SIGNATURE_WINDOW_MS) {
    return { ok: false, reason: "outside_window" }
  }
  if (!isCanonicalSignedPath(input.path)) return { ok: false, reason: "bad_path" }
  if (/[\n\r]/.test(runId)) return { ok: false, reason: "bad_signature" }
  const signatureBytes = base64UrlToBytes(signature)
  if (!signatureBytes || signatureBytes.byteLength !== 32) {
    return { ok: false, reason: "bad_signature" }
  }
  const secret = await input.resolveSecret(keyId)
  if (!secret) return { ok: false, reason: "unknown_key" }
  const message = canonicalProbeSigningInput({
    method: input.method,
    path: input.path,
    timestampMs,
    runId,
    bodySha256Hex: await sha256Hex(input.body),
  })
  const key = await hmacKey(secret, "verify")
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    buffer(signatureBytes),
    buffer(encoder.encode(message))
  )
  return valid ? { ok: true, keyId, runId, timestampMs } : { ok: false, reason: "bad_signature" }
}
