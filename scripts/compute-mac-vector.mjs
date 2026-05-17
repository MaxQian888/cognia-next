// Throwaway helper: computes EXPECTED_MAC_VECTOR_V1 for the cross-implementation
// MAC pin asserted by both:
//   - lib/signaling/envelope.test.ts
//   - src-tauri/src/companion_api/signaling/envelope.rs
//
// Run with:
//   node scripts/compute-mac-vector.mjs
//
// Re-execute this script ONLY after intentionally re-cutting the canonical
// envelope layout (and bumping `ver`). Copy the printed value back into the
// two test files. Otherwise treat any MAC drift as a regression — both
// implementations must produce the same byte sequence over the fixed input
// below; the test pin protects production traffic from silent divergence.
//
// This script is pure ESM with zero TypeScript / project imports so it
// always runs under bare Node. The canonical-JSON + HMAC algorithms are
// duplicated by hand from `lib/signaling/envelope.ts`; if those upstream
// implementations change, mirror the change here too — but the actual
// production tests (Rust + TS) are what pin agreement, so brief drift in
// this helper is recoverable, not load-bearing.

import { webcrypto } from "node:crypto"

const crypto = globalThis.crypto ?? webcrypto

// ---------------------------------------------------------------------------
// Canonical JSON — keys sorted by UTF-16 code-unit order (matches
// JavaScript's default `Array.prototype.sort` on string keys).
// ---------------------------------------------------------------------------

function canonical(value) {
  if (value === null) return "null"
  if (value === undefined) throw new Error("canonical: undefined not allowed")
  const t = typeof value
  if (t === "boolean") return value ? "true" : "false"
  if (t === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical: non-finite number")
    if (!Number.isInteger(value)) throw new Error("canonical: non-integer number")
    return String(value)
  }
  if (t === "string") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`
  }
  if (t === "object") {
    const keys = Object.keys(value).sort() // UTF-16 ordering — default
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    return `{${parts.join(",")}}`
  }
  throw new Error(`canonical: unsupported value type: ${t}`)
}

// ---------------------------------------------------------------------------
// Base64url + HMAC-SHA256 (Web Crypto)
// ---------------------------------------------------------------------------

function base64UrlFromBytes(bytes) {
  const bin = String.fromCharCode(...bytes)
  return Buffer.from(bin, "binary")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function base64UrlToBytes(s) {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4)
  return new Uint8Array(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64"))
}

async function hmacSha256(secretBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))
  return new Uint8Array(sig)
}

// ---------------------------------------------------------------------------
// Deterministic input vector — duplicated from envelope.test.ts /
// envelope.rs::mac_matches_cross_implementation_vector_v1.
// ---------------------------------------------------------------------------

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" // 32-byte URL-safe-b64

const envelope = {
  ver: 1,
  ts: 1_700_000_000_000,
  nonce: "nonce-abcdef",
  seq: 42,
  kind: "rtc:offer",
  body: { sdp: "v=0\r\nmock" },
  mac: "", // placeholder for canonical-JSON / HMAC input
}

const canonicalBytes = canonical(envelope)
const secretBytes = base64UrlToBytes(SECRET)
if (secretBytes.length !== 32) {
  throw new Error(`expected 32-byte secret, got ${secretBytes.length}`)
}
const macBytes = await hmacSha256(secretBytes, canonicalBytes)
const mac = base64UrlFromBytes(macBytes)

console.log("EXPECTED_MAC_VECTOR_V1:", mac)
