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
