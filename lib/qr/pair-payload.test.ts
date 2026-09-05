import { decodePairPayload, encodePairPayload } from "./pair-payload"

const payload = {
  baseUrl: "https://192.168.1.10:27890",
  mode: "owner-invitation" as const,
  invitation: "one-time-secret",
  hostId: "host-a",
  tenantId: "tenant-a",
  expiresAt: Date.now() + 60_000,
  serverVersion: "1.0.0",
  fingerprint: "deadbeef",
}

describe("pair payload v3", () => {
  it("round-trips without embedding a bearer token", () => {
    const encoded = encodePairPayload(payload)
    expect(encoded.startsWith("cgnp3|")).toBe(true)
    expect(encoded).not.toContain("=")
    expect(encoded).not.toContain("Bearer")
    expect(decodePairPayload(encoded)).toEqual({ kind: "ok", payload })
  })

  it("rejects every older payload format", () => {
    expect(decodePairPayload("cgnp2|legacy")).toEqual({ kind: "version_mismatch", got: 2 })
    expect(decodePairPayload(JSON.stringify({ baseUrl: payload.baseUrl }))).toEqual({
      kind: "wrong_format",
    })
  })

  it("rejects expired invitations", () => {
    const encoded = encodePairPayload({ ...payload, expiresAt: Date.now() - 1 })
    expect(decodePairPayload(encoded)).toEqual({
      kind: "invalid",
      message: "pairing invitation has expired",
    })
  })

  it("round-trips oidc mode without an invitation", () => {
    const oidc = { ...payload, mode: "oidc" as const, invitation: undefined }
    const encoded = encodePairPayload(oidc)
    expect(decodePairPayload(encoded)).toEqual({ kind: "ok", payload: oidc })
    const decodedBody = JSON.parse(
      Buffer.from(encoded.slice("cgnp3|".length), "base64url").toString("utf8")
    )
    expect(decodedBody).not.toHaveProperty("invitation")
  })

  it("enforces mode-specific invitation presence", () => {
    const encodeRaw = (value: Record<string, unknown>) =>
      `cgnp3|${Buffer.from(JSON.stringify(value)).toString("base64url")}`
    const common = {
      base: payload.baseUrl,
      host: payload.hostId,
      tenant: payload.tenantId,
      exp: payload.expiresAt,
      ver: payload.serverVersion,
      fp: payload.fingerprint,
    }
    expect(decodePairPayload(encodeRaw({ ...common, mode: "owner-invitation" }))).toEqual({
      kind: "invalid",
      message: "missing invitation",
    })
    expect(
      decodePairPayload(encodeRaw({ ...common, mode: "oidc", invitation: "must-not-leak" }))
    ).toEqual({
      kind: "invalid",
      message: "oidc payload must not contain invitation",
    })
  })
})

describe("pair payload v4 (relay, ADR-0170)", () => {
  const relay = {
    url: "wss://signaling.example/signaling",
    room: {
      v: 2 as const,
      roomId: "room-id",
      roomNonce: "nonce",
      desktopSigningKey: "desktop-key",
      mobileSigningKey: "mobile-key",
      notAfter: Date.now() + 60_000,
    },
    mobilePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "d", x: "x", y: "y" },
  }

  it("emits cgnp4 only when a relay is present and round-trips it", () => {
    const encoded = encodePairPayload({ ...payload, relay })
    expect(encoded.startsWith("cgnp4|")).toBe(true)
    expect(decodePairPayload(encoded)).toEqual({ kind: "ok", payload: { ...payload, relay } })
    // Without a relay the wire stays cgnp3 so pre-relay phones keep reading it.
    expect(encodePairPayload(payload).startsWith("cgnp3|")).toBe(true)
  })

  it("still decodes cgnp3 and never invents a relay for it", () => {
    const decoded = decodePairPayload(encodePairPayload(payload))
    expect(decoded.kind).toBe("ok")
    expect(decoded.kind === "ok" && decoded.payload.relay).toBeUndefined()
  })

  it("rejects a relay whose key or room is malformed", () => {
    const encodeRaw = (value: Record<string, unknown>) =>
      `cgnp4|${Buffer.from(JSON.stringify(value)).toString("base64url")}`
    const common = {
      base: payload.baseUrl,
      host: payload.hostId,
      tenant: payload.tenantId,
      exp: payload.expiresAt,
      ver: payload.serverVersion,
      fp: payload.fingerprint,
      mode: "owner-invitation",
      invitation: payload.invitation,
    }
    expect(
      decodePairPayload(
        encodeRaw({ ...common, relay: { ...relay, mobilePrivateKeyJwk: { kty: "RSA" } } })
      )
    ).toEqual({ kind: "invalid", message: "invalid relay key" })
    expect(decodePairPayload(encodeRaw({ ...common, relay: { url: "wss://x" } }))).toEqual({
      kind: "invalid",
      message: "invalid relay room",
    })
  })
})
