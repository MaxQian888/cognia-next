/** @jest-environment jsdom */
/**
 * Coverage for the HMAC envelope: deterministic canonical JSON, round-trip
 * sign/verify, replay window, clock-skew enforcement, and tamper detection.
 */

import {
  ReplayWindow,
  buildSignedEnvelope,
  canonicalJson,
  freshNonce,
  verifySignedEnvelope,
} from "./envelope"
import type { Envelope } from "./types"

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" // 32 bytes URL-safe-b64

/**
 * Cross-implementation MAC pin. Both `lib/signaling/envelope.test.ts` and
 * `src-tauri/src/companion_api/signaling/envelope.rs` assert this exact MAC
 * for the fixed envelope tuple below. If either implementation drifts on
 * canonical-JSON encoding, HMAC computation, or base64url framing, one of
 * the two sides will fail this assertion before any production envelope ever
 * gets exchanged. Recompute via `scripts/compute-mac-vector.mjs` if you ever
 * intentionally re-cut the canonical layout (and bump `ver`).
 */
const EXPECTED_MAC_VECTOR_V1 = "gCsrVgz1X_cWBTd4LR01XEjWzNmIauI8yMrdn5QlLx4"

describe("canonicalJson", () => {
  it("sorts object keys lexicographically at every depth", () => {
    const obj = { b: 1, a: { z: 2, y: 3 } }
    expect(canonicalJson(obj)).toBe(`{"a":{"y":3,"z":2},"b":1}`)
  })

  it("preserves array order", () => {
    expect(canonicalJson({ x: [3, 1, 2] })).toBe(`{"x":[3,1,2]}`)
  })

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ x: NaN })).toThrow(/non-finite/)
  })

  it("rejects unsupported value types", () => {
    expect(() => canonicalJson({ x: undefined })).toThrow(/undefined/)
  })

  it("rejects non-integer finite numbers (would diverge from Rust serde_json)", () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow(/non-integer/)
    expect(() => canonicalJson({ x: -0.1 })).toThrow(/non-integer/)
    // 1.0 is an integer in JS (`Number.isInteger(1.0) === true`), so it is
    // accepted — it serialises as `1` on both sides.
    expect(canonicalJson({ x: 1.0 })).toBe(`{"x":1}`)
  })

  it("sorts non-ASCII keys by UTF-16 code units (reference for the Rust mirror)", () => {
    // `é` (U+00E9) > `z` (U+007A) in UTF-16 code-unit order, so `z` comes
    // first. The Rust side MUST produce the same byte sequence — see
    // `envelope.rs::canonical_json_sorts_non_ascii_by_utf16`.
    expect(canonicalJson({ é: 1, z: 2 })).toBe(`{"z":2,"é":1}`)
    // Astral codepoint U+1F600 is encoded as a surrogate pair (0xD83D, 0xDE00),
    // which sorts after any BMP codepoint when compared as u16 sequences.
    expect(canonicalJson({ "\u{1f600}": 1, a: 2 })).toBe(`{"a":2,"😀":1}`)
  })

  it("handles null body, nested arrays of objects, and string edge cases", () => {
    expect(canonicalJson({ body: null })).toBe(`{"body":null}`)
    expect(
      canonicalJson({
        a: [
          { b: 1, a: 2 },
          { d: 4, c: 3 },
        ],
      })
    ).toBe(`{"a":[{"a":2,"b":1},{"c":3,"d":4}]}`)
    // JSON.stringify escapes control chars, double quotes, and backslashes —
    // the canonical output must contain those exact escapes.
    expect(canonicalJson({ s: '\u0000\u001f\\"' })).toBe(`{"s":"\\u0000\\u001f\\\\\\""}`)
  })
})

describe("buildSignedEnvelope + verifySignedEnvelope", () => {
  it("round-trips and verifies with the same secret", async () => {
    const env = await buildSignedEnvelope({
      seq: 1,
      kind: "hello",
      body: { deviceId: "abc" },
      rendezvousSecret: SECRET,
    })
    expect(env.ver).toBe(1)
    expect(env.nonce).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(env.mac).toMatch(/^[A-Za-z0-9_-]+$/)

    const result = await verifySignedEnvelope(env, { rendezvousSecret: SECRET })
    expect(result.ok).toBe(true)
  })

  it("verification fails when the secret differs", async () => {
    const env = await buildSignedEnvelope({
      seq: 1,
      kind: "hello",
      body: {},
      rendezvousSecret: SECRET,
    })
    const wrong = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZQ"
    const result = await verifySignedEnvelope(env, { rendezvousSecret: wrong })
    expect(result).toEqual({ ok: false, reason: "mac_mismatch" })
  })

  it("rejects tampered bodies", async () => {
    const env = await buildSignedEnvelope({
      seq: 1,
      kind: "rtc:offer",
      body: { sdp: "real" },
      rendezvousSecret: SECRET,
    })
    const tampered: Envelope = { ...env, body: { sdp: "evil" } }
    const result = await verifySignedEnvelope(tampered, { rendezvousSecret: SECRET })
    expect(result).toEqual({ ok: false, reason: "mac_mismatch" })
  })

  it("rejects future timestamps beyond the window", async () => {
    const env = await buildSignedEnvelope({
      ts: Date.now() + 10 * 60 * 1000, // 10 min in the future
      seq: 1,
      kind: "hello",
      body: {},
      rendezvousSecret: SECRET,
    })
    const result = await verifySignedEnvelope(env, { rendezvousSecret: SECRET })
    expect(result).toEqual({ ok: false, reason: "clock_skew" })
  })

  it("rejects past timestamps beyond the window", async () => {
    const tenMinAgo = Date.now() - 10 * 60 * 1000
    const env = await buildSignedEnvelope({
      ts: tenMinAgo,
      seq: 1,
      kind: "hello",
      body: {},
      rendezvousSecret: SECRET,
    })
    const result = await verifySignedEnvelope(env, { rendezvousSecret: SECRET })
    expect(result).toEqual({ ok: false, reason: "clock_skew" })
  })

  it("rejects envelopes with the wrong version", async () => {
    const env = await buildSignedEnvelope({
      seq: 1,
      kind: "hello",
      body: {},
      rendezvousSecret: SECRET,
    })
    const bad = { ...env, ver: 2 }
    const result = await verifySignedEnvelope(bad, { rendezvousSecret: SECRET })
    expect(result).toEqual({ ok: false, reason: "version" })
  })

  it("rejects malformed shapes", async () => {
    expect(await verifySignedEnvelope({ what: "ever" }, { rendezvousSecret: SECRET })).toEqual({
      ok: false,
      reason: "shape",
    })
    expect(await verifySignedEnvelope(null, { rendezvousSecret: SECRET })).toEqual({
      ok: false,
      reason: "shape",
    })
  })

  it("reports mac_mismatch (not throws) on malformed mac base64", async () => {
    const env = await buildSignedEnvelope({
      seq: 1,
      kind: "hello",
      body: {},
      rendezvousSecret: SECRET,
    })
    // Non-base64url characters — `!` is outside [A-Za-z0-9_-].
    const badChars: Envelope = { ...env, mac: "!!!!!!!" }
    expect(await verifySignedEnvelope(badChars, { rendezvousSecret: SECRET })).toEqual({
      ok: false,
      reason: "mac_mismatch",
    })
    // Length mod 4 == 1 is structurally invalid base64.
    const badLength: Envelope = { ...env, mac: "AAAAA" }
    expect(await verifySignedEnvelope(badLength, { rendezvousSecret: SECRET })).toEqual({
      ok: false,
      reason: "mac_mismatch",
    })
  })

  it("matches the cross-implementation MAC vector EXPECTED_MAC_VECTOR_V1", async () => {
    // Deterministic input: see `scripts/compute-mac-vector.mjs` for how the
    // expected value was minted. The Rust side asserts the same constant
    // (`src-tauri/src/companion_api/signaling/envelope.rs::EXPECTED_MAC_VECTOR_V1`)
    // for the same input, pinning byte-for-byte agreement.
    const env = await buildSignedEnvelope({
      ts: 1_700_000_000_000,
      nonce: "nonce-abcdef",
      seq: 42,
      kind: "rtc:offer",
      body: { sdp: "v=0\r\nmock" },
      rendezvousSecret: SECRET,
    })
    expect(env.mac).toBe(EXPECTED_MAC_VECTOR_V1)
  })
})

describe("ReplayWindow", () => {
  it("accepts fresh tuples", () => {
    const w = new ReplayWindow()
    expect(w.observe("mobile", 1, freshNonce())).toBe(true)
    expect(w.observe("mobile", 2, freshNonce())).toBe(true)
  })

  it("rejects repeated seq from the same role", () => {
    const w = new ReplayWindow()
    expect(w.observe("mobile", 1, "n1")).toBe(true)
    expect(w.observe("mobile", 1, "n2")).toBe(false)
  })

  it("rejects repeated nonce from the same role even if seq differs", () => {
    const w = new ReplayWindow()
    expect(w.observe("mobile", 1, "n1")).toBe(true)
    expect(w.observe("mobile", 2, "n1")).toBe(false)
  })

  it("scopes per role — same seq under different roles is fine", () => {
    const w = new ReplayWindow()
    expect(w.observe("mobile", 42, "a")).toBe(true)
    expect(w.observe("desktop", 42, "b")).toBe(true)
  })

  it("LRU evicts old entries", () => {
    const w = new ReplayWindow(2)
    expect(w.observe("mobile", 1, "n1")).toBe(true)
    expect(w.observe("mobile", 2, "n2")).toBe(true)
    expect(w.observe("mobile", 3, "n3")).toBe(true)
    // seq=1 has been evicted, so it should be accepted again. (This is the
    // expected behaviour of a fixed-size replay window — receivers
    // additionally rely on the clock-skew window to bound how far back an
    // attacker could meaningfully replay.)
    expect(w.observe("mobile", 1, "n4")).toBe(true)
  })

  it("LRU evicts strictly the oldest entry on overflow", () => {
    const w = new ReplayWindow(3)
    expect(w.observe("mobile", 1, "n1")).toBe(true)
    expect(w.observe("mobile", 2, "n2")).toBe(true)
    expect(w.observe("mobile", 3, "n3")).toBe(true)
    // Capacity is 3; the next unique push evicts the oldest (seq=1).
    expect(w.observe("mobile", 4, "n4")).toBe(true)
    // seq=1 is gone (fresh again); seq=2, 3, 4 are all still in the window.
    expect(w.observe("mobile", 1, "n1b")).toBe(true)
    expect(w.observe("mobile", 3, "n3b")).toBe(false)
    expect(w.observe("mobile", 4, "n4b")).toBe(false)
  })

  it("role scoping prevents key collision but the LRU itself is global", () => {
    // Both roles share one capacity-bounded LRU; role prefixing only ensures
    // `mobile|1` and `desktop|1` are distinct keys so the same numeric seq
    // can coexist. It does NOT keep desktop entries alive when subsequent
    // mobile pushes overflow the global window — the receiver still leans on
    // the 5-minute clock-skew window to bound how far back an attacker can
    // meaningfully replay.
    const w = new ReplayWindow(2)
    expect(w.observe("desktop", 1, "d1")).toBe(true)
    expect(w.observe("mobile", 1, "m1")).toBe(true)
    // Both keys are distinct (no false positive), but the window is full.
    expect(w.observe("desktop", 1, "d1-replay-immediate")).toBe(false)
    // Third push evicts the oldest entry (desktop|1) from the global LRU.
    expect(w.observe("mobile", 2, "m2")).toBe(true)
    // After that, the desktop|1 tuple is gone and a replay is accepted again.
    expect(w.observe("desktop", 1, "d1-replay-after-evict")).toBe(true)
  })
})

describe("freshNonce", () => {
  it("is URL-safe base64 of 16 random bytes", () => {
    const a = freshNonce()
    const b = freshNonce()
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThanOrEqual(21) // 16 bytes → ~22 chars
    expect(a).not.toEqual(b)
  })

  it("uses the crypto provider", () => {
    const spy = jest.spyOn(globalThis.crypto, "getRandomValues")
    freshNonce()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
