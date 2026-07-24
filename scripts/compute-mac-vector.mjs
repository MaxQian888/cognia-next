#!/usr/bin/env node
/**
 * Cross-implementation HMAC vector generator for the signaling envelope
 * (ADR-0021). BOTH `lib/signaling/envelope.ts` and
 * `src-tauri/src/companion_api/signaling/envelope.rs` pin a constant
 * (`EXPECTED_MAC_VECTOR_V1`) computed for a fixed envelope tuple; this script
 * is what those constants were minted from. Two comments in envelope.rs and
 * one in envelope.test.ts pointed here, but the file had gone missing — so the
 * only defence against the TS and Rust canonical-JSON / HMAC / base64url paths
 * silently drifting was a hand-copied constant nobody could regenerate.
 *
 * It re-implements the canonical-JSON encoding of `envelope.ts:canonicalJson`
 * (lexicographic UTF-16 key sort, integer-only numbers, array order preserved)
 * and HMAC-SHA256 over the UTF-8 canonical bytes with the base64url-decoded
 * 32-byte secret, emitting the mac as unpadded base64url.
 *
 * Usage:
 *   node scripts/compute-mac-vector.mjs            # print every vector as JSON
 *   node scripts/compute-mac-vector.mjs --check    # verify V1 matches the pin, exit 1 on drift
 *   node scripts/compute-mac-vector.mjs --write     # (re)write scripts/smoke/webrtc-mac-vectors.json
 *
 * If `--check` fails, the TS/Rust envelope implementations have diverged on the
 * wire format — investigate BEFORE touching the pinned constants, because a
 * changed mac breaks every production envelope exchange.
 */

import { createHmac } from "node:crypto"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import process from "node:process"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** The 32-byte HMAC secret shared by both cross-impl tests (base64url). */
const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

/**
 * Value pinned in `lib/signaling/envelope.test.ts` and
 * `src-tauri/.../signaling/envelope.rs`. Kept here so `--check` fails loudly on
 * drift. If you INTENTIONALLY re-cut the canonical layout (and bump `ver`),
 * update all three in lockstep.
 */
const EXPECTED_MAC_VECTOR_V1 = "gCsrVgz1X_cWBTd4LR01XEjWzNmIauI8yMrdn5QlLx4"

// ---------------------------------------------------------------------------
// Canonical JSON — byte-identical to lib/signaling/envelope.ts:canonicalJson
// ---------------------------------------------------------------------------

function canonicalise(value) {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(canonicalise)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number not supported")
    if (!Number.isInteger(value)) throw new TypeError("non-integer number not supported")
    return value
  }
  if (typeof value === "object") {
    const out = {}
    // Object.keys(...).sort() is UTF-16 code-unit order — matched on the Rust
    // side by `keys.sort_by(utf16 units)`.
    for (const k of Object.keys(value).sort()) out[k] = canonicalise(value[k])
    return out
  }
  if (typeof value === "string" || typeof value === "boolean") return value
  throw new TypeError(`unsupported value type: ${typeof value}`)
}

function canonicalJson(value) {
  return JSON.stringify(canonicalise(value))
}

// ---------------------------------------------------------------------------
// base64url + HMAC
// ---------------------------------------------------------------------------

function base64UrlToBytes(input) {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4)
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64")
}

function bytesToBase64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

/** Sign the envelope over `{...envelope, mac: ""}` — the same draft both
 *  implementations feed to HMAC. Returns the mac as unpadded base64url. */
function macFor(envelope) {
  const key = base64UrlToBytes(SECRET)
  if (key.length !== 32) throw new Error(`secret must decode to 32 bytes, got ${key.length}`)
  const message = Buffer.from(canonicalJson({ ...envelope, mac: "" }), "utf8")
  return bytesToBase64Url(createHmac("sha256", key).update(message).digest())
}

function signedEnvelope(fields) {
  const draft = { ver: 1, mac: "", ...fields }
  return { ...draft, mac: macFor(draft) }
}

// ---------------------------------------------------------------------------
// Vectors — V1 is the pin; the rest broaden coverage (non-ASCII, ICE candidate
// body, nested arrays) so a future divergence in any of those paths is caught.
// ---------------------------------------------------------------------------

const VECTORS = [
  {
    name: "v1-rtc-offer",
    ts: 1_700_000_000_000,
    nonce: "nonce-abcdef",
    seq: 42,
    kind: "rtc:offer",
    body: { sdp: "v=0\r\nmock" },
  },
  {
    name: "hello-non-ascii",
    ts: 1_700_000_000_000,
    nonce: "nonce-unicode",
    seq: 1,
    kind: "hello",
    body: { deviceId: "设备-é-😀" },
  },
  {
    name: "rtc-ice-candidate",
    ts: 1_700_000_000_001,
    nonce: "nonce-ice",
    seq: 7,
    kind: "rtc:ice",
    body: {
      candidate: {
        candidate: "candidate:1 1 udp 2130706431 192.168.1.2 54321 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
    },
  },
]

function buildAll() {
  return VECTORS.map((v) => {
    const { name, ...fields } = v
    const env = signedEnvelope(fields)
    return { name, envelope: env, mac: env.mac }
  })
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const mode = process.argv[2]
const vectors = buildAll()
const v1 = vectors.find((v) => v.name === "v1-rtc-offer")

if (mode === "--check") {
  if (v1.mac !== EXPECTED_MAC_VECTOR_V1) {
    console.error(
      `[compute-mac-vector] DRIFT: v1 mac ${v1.mac} != pinned ${EXPECTED_MAC_VECTOR_V1}`
    )
    process.exit(1)
  }
  console.log("[compute-mac-vector] OK — v1 matches the pinned cross-impl vector")
  process.exit(0)
}

if (mode === "--write") {
  const outPath = join(__dirname, "smoke", "webrtc-mac-vectors.json")
  writeFileSync(outPath, JSON.stringify({ secret: SECRET, vectors }, null, 2) + "\n")
  console.log(`[compute-mac-vector] wrote ${outPath}`)
  process.exit(0)
}

// Default: print. Assert V1 as a courtesy so a bare run still flags drift.
if (v1.mac !== EXPECTED_MAC_VECTOR_V1) {
  console.error(
    `[compute-mac-vector] WARNING: v1 mac ${v1.mac} != pinned ${EXPECTED_MAC_VECTOR_V1}`
  )
}
console.log(JSON.stringify({ secret: SECRET, vectors }, null, 2))
