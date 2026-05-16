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
