/**
 * End-to-end HMAC-SHA256 sign/verify for signaling envelopes. ADR-0021.
 *
 * The public signaling rendezvous is untrusted. Both peers tag every
 * application-level signaling message with HMAC-SHA256 over a canonical
 * JSON encoding of the envelope; the receiver verifies before acting on
 * any SDP/ICE content. Implementation lives in Web Crypto so it runs in
 * both Capacitor WebViews (iOS/Android) and the Tauri WebView.
 *
 * Wire format mirrors `signaling-server/src/proto.rs::Envelope`:
 *   { ver, ts, nonce, seq, kind, body, mac }
 *
 * The canonical JSON used for the MAC is the same object with `mac: ""`,
 * with keys serialised in fixed lexicographic order via {@link canonicalJson}.
 *
 * Replay protection is enforced by the receiver:
 *   - `|ts - now| <= REPLAY_CLOCK_SKEW_MS`
 *   - `(rendezvousId, role, seq)` and `(rendezvousId, role, nonce)` are
 *     tracked in a 256-entry per-room LRU; either repeat is rejected.
 */

import {
  REPLAY_CLOCK_SKEW_MS,
  REPLAY_LRU_CAPACITY,
  type Envelope,
  type EnvelopeKind,
  type PeerRole,
} from "./types"

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

const URL_SAFE_RE = /^[A-Za-z0-9_-]*$/

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function base64UrlToBytes(input: string): Uint8Array {
  if (!URL_SAFE_RE.test(input)) {
    throw new Error("base64url: invalid characters")
  }
  // A base64url string's length mod 4 must be 0, 2, or 3 — a tail of 1 char
  // encodes 6 bits which can never round-trip from a whole byte.
  if (input.length % 4 === 1) {
    throw new Error("base64url: invalid length")
  }
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4)
  const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Produces a deterministic JSON encoding of `value` with object keys sorted
 * lexicographically (UTF-16 codepoint order). Arrays preserve their input
 * order. Used both for HMAC input and for cross-language interoperability
 * with the Rust side.
 *
 * Supports JSON-serialisable values only: string, number (finite), boolean,
 * null, plain objects, arrays. Anything else throws.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value))
}

function canonicalise(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return value.map(canonicalise)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalJson: non-finite number not supported")
    }
    // Floats serialise differently between JS (`JSON.stringify(1.0)` → `"1"`)
    // and Rust (`serde_json::Number::from_f64(1.0)` → `"1.0"`). Reject
    // non-integers outright so the canonical encoding stays byte-identical
    // across the TS and Rust implementations of the envelope.
    if (!Number.isInteger(value)) {
      throw new TypeError("canonicalJson: non-integer number not supported")
    }
    return value
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    const keys = Object.keys(obj).sort()
    for (const k of keys) out[k] = canonicalise(obj[k])
    return out
  }
  if (typeof value === "string" || typeof value === "boolean") return value
  throw new TypeError(`canonicalJson: unsupported value type: ${typeof value}`)
}

// ---------------------------------------------------------------------------
// HMAC primitive
// ---------------------------------------------------------------------------

type CryptoProvider = {
  subtle: SubtleCrypto
  getRandomValues<T extends ArrayBufferView>(buf: T): T
}

function provider(): CryptoProvider {
  // `crypto.subtle` is available in WKWebView, Android WebView (Chromium
  // ≥ 49), Node 19+, and the Tauri WebView. We assert non-null here and
  // let the throw surface as a clear capability error if a hosting env
  // lacks subtle crypto.
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
    throw new Error("Web Crypto Subtle API is not available in this environment")
  }
  return globalThis.crypto as CryptoProvider
}

async function importSecret(secretBase64Url: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(secretBase64Url)
  if (raw.length !== 32) {
    throw new Error(`signaling secret must be 32 bytes, got ${raw.length}`)
  }
  // TypeScript's lib.dom.d.ts narrows `BufferSource` to
  // `ArrayBufferView<ArrayBuffer> | ArrayBuffer`, whereas the runtime
  // `Uint8Array` is `Uint8Array<ArrayBufferLike>`. The cast is safe — our
  // `base64UrlToBytes` always allocates a fresh `Uint8Array(len)` backed
  // by an `ArrayBuffer`, never a `SharedArrayBuffer`.
  return provider().subtle.importKey(
    "raw",
    raw as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildEnvelopeArgs {
  ts?: number
  nonce?: string
  seq: number
  kind: EnvelopeKind
  body: unknown
  rendezvousSecret: string
}

/**
 * Build a signed envelope ready to be base64-encoded and embedded in a
 * `Relay` frame. `ts` defaults to `Date.now()`; `nonce` defaults to 16
 * random bytes (URL-safe base64).
 */
export async function buildSignedEnvelope(args: BuildEnvelopeArgs): Promise<Envelope> {
  const ts = args.ts ?? Date.now()
  const nonce = args.nonce ?? freshNonce()
  const draft: Envelope = {
    ver: 1,
    ts,
    nonce,
    seq: args.seq,
    kind: args.kind,
    body: args.body,
    mac: "",
  }
  const macBytes = await macFor(draft, args.rendezvousSecret)
  draft.mac = bytesToBase64Url(macBytes)
  return draft
}

export interface VerifyOutcome {
  ok: true
  envelope: Envelope
}
export interface VerifyFailure {
  ok: false
  // Replay detection lives in `ReplayWindow.observe` (boolean return), not in
  // this function — so no `replayed_*` reasons here. A malformed `mac` (bad
  // base64url chars or length) is reported as `mac_mismatch` to keep the wire
  // contract opaque to attackers.
  reason: "shape" | "version" | "clock_skew" | "mac_mismatch"
}
export type VerifyResult = VerifyOutcome | VerifyFailure

export interface VerifyArgs {
  rendezvousSecret: string
  /** Optional override for clock skew (defaults to {@link REPLAY_CLOCK_SKEW_MS}). */
  clockSkewMs?: number
  /** Defaults to `Date.now()`. Override for deterministic tests. */
  nowMs?: number
}

/**
 * Verify HMAC, version, and clock window. Replay protection (seq/nonce LRU)
 * is the caller's responsibility — pass each verified envelope through
 * {@link ReplayWindow}.
 */
export async function verifySignedEnvelope(raw: unknown, args: VerifyArgs): Promise<VerifyResult> {
  if (!isEnvelopeShape(raw)) return { ok: false, reason: "shape" }
  if (raw.ver !== 1) return { ok: false, reason: "version" }
  const now = args.nowMs ?? Date.now()
  const skew = args.clockSkewMs ?? REPLAY_CLOCK_SKEW_MS
  if (Math.abs(raw.ts - now) > skew) return { ok: false, reason: "clock_skew" }
  let presented: Uint8Array
  try {
    presented = base64UrlToBytes(raw.mac)
  } catch {
    return { ok: false, reason: "mac_mismatch" }
  }
  const expected = await macFor({ ...raw, mac: "" } as Envelope, args.rendezvousSecret)
  if (!constantTimeEquals(presented, expected)) {
    return { ok: false, reason: "mac_mismatch" }
  }
  return { ok: true, envelope: raw }
}

function isEnvelopeShape(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.ver === "number" &&
    typeof v.ts === "number" &&
    typeof v.nonce === "string" &&
    typeof v.seq === "number" &&
    typeof v.kind === "string" &&
    "body" in v &&
    typeof v.mac === "string"
  )
}

async function macFor(envelope: Envelope, secretBase64Url: string): Promise<Uint8Array> {
  const key = await importSecret(secretBase64Url)
  const message = new TextEncoder().encode(canonicalJson(envelope))
  const sig = await provider().subtle.sign("HMAC", key, message as BufferSource)
  return new Uint8Array(sig)
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export function freshNonce(): string {
  const buf = new Uint8Array(16)
  provider().getRandomValues(buf)
  return bytesToBase64Url(buf)
}

// ---------------------------------------------------------------------------
// Replay window
// ---------------------------------------------------------------------------

/**
 * Per-room (sender-aware) seq/nonce LRU. The window tracks the last
 * {@link REPLAY_LRU_CAPACITY} `(role, seq)` and `(role, nonce)` pairs and
 * rejects repeats. Sender uniqueness is enforced because both sides
 * maintain *independent* monotonic counters; we don't want a desktop
 * `seq=42` to invalidate a mobile `seq=42`.
 */
export class ReplayWindow {
  private readonly seqs = new Set<string>()
  private readonly seqOrder: string[] = []
  private readonly nonces = new Set<string>()
  private readonly nonceOrder: string[] = []
  private readonly capacity: number

  constructor(capacity = REPLAY_LRU_CAPACITY) {
    this.capacity = capacity
  }

  /**
   * Returns `true` if the (role, seq, nonce) tuple is fresh and should be
   * accepted; `false` if it has already been seen (replay).
   */
  observe(role: PeerRole, seq: number, nonce: string): boolean {
    const seqKey = `${role}|${seq}`
    if (this.seqs.has(seqKey)) return false
    const nonceKey = `${role}|${nonce}`
    if (this.nonces.has(nonceKey)) return false
    this.seqs.add(seqKey)
    this.seqOrder.push(seqKey)
    if (this.seqOrder.length > this.capacity) {
      const oldest = this.seqOrder.shift()!
      this.seqs.delete(oldest)
    }
    this.nonces.add(nonceKey)
    this.nonceOrder.push(nonceKey)
    if (this.nonceOrder.length > this.capacity) {
      const oldest = this.nonceOrder.shift()!
      this.nonces.delete(oldest)
    }
    return true
  }
}
