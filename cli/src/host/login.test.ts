import { loginHost } from "./login"

const CONFIG = { deploymentMode: "single-user", hostId: "host_1", tenantId: "tnt_1" }

function paired(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "https://h",
    deviceId: "dev_1",
    devicePrivateKeyJwk: { kty: "EC", d: "secret" },
    deviceKeyThumbprint: "thumb",
    serverVersion: "3",
    ...overrides,
  }
}

describe("loginHost", () => {
  it("reads the host and tenant ids from the public config", async () => {
    const seen: Array<Record<string, unknown>> = []
    const result = await loginHost({
      endpoint: "https://h/",
      invitation: "CODE",
      fetchConfig: async () => CONFIG as never,
      register: async (input) => {
        seen.push(input as Record<string, unknown>)
        return paired() as never
      },
    })
    expect(result.ok).toBe(true)
    expect(seen[0]).toMatchObject({
      baseUrl: "https://h",
      mode: "owner-invitation",
      invitation: "CODE",
      hostId: "host_1",
      tenantId: "tnt_1",
      displayName: "Cognia CLI",
    })
  })

  it("records a device host with the pinned fingerprint", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      serverFingerprint: "aa".repeat(32),
      fetchConfig: async () => CONFIG as never,
      register: async () => paired({ serverFingerprint: "bb".repeat(32) }) as never,
    })
    expect(result).toMatchObject({
      ok: true,
      record: { kind: "device", endpoint: "https://h", serverFingerprint: "bb".repeat(32) },
    })
  })

  it("keeps the fingerprint the operator supplied when the host returns none", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      serverFingerprint: "cc".repeat(32),
      fetchConfig: async () => CONFIG as never,
      register: async () => paired({ serverFingerprint: undefined }) as never,
    })
    expect((result as { record: { serverFingerprint: string } }).record.serverFingerprint).toBe(
      "cc".repeat(32)
    )
  })

  it("honours an explicit tenant over the one the host advertises", async () => {
    const seen: Array<Record<string, unknown>> = []
    await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      tenantId: "chosen",
      fetchConfig: async () => CONFIG as never,
      register: async (input) => {
        seen.push(input as Record<string, unknown>)
        return paired() as never
      },
    })
    expect(seen[0].tenantId).toBe("chosen")
  })

  it("uses the label as the display name the owner will see", async () => {
    const seen: Array<Record<string, unknown>> = []
    await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      displayName: "build box",
      fetchConfig: async () => CONFIG as never,
      register: async (input) => {
        seen.push(input as Record<string, unknown>)
        return paired() as never
      },
    })
    expect(seen[0].displayName).toBe("build box")
  })

  it("refuses a multi-tenant host and names the OIDC route", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      fetchConfig: async () => ({ deploymentMode: "multi-tenant", hostId: "h" }) as never,
      register: async () => paired() as never,
    })
    expect(result).toMatchObject({ ok: false })
    expect((result as { failure: { fix: string[] } }).failure.fix[0]).toContain("logto login")
  })

  it("refuses when neither the host nor the operator names a tenant", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      fetchConfig: async () => ({ deploymentMode: "single-user", hostId: "h" }) as never,
      register: async () => paired() as never,
    })
    expect((result as { failure: { fix: string[] } }).failure.fix[0]).toContain("--tenant")
  })

  it("classifies an unreachable host as network and suggests the fingerprint", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      fetchConfig: async () => {
        throw new Error("self signed certificate")
      },
    })
    const failure = (result as { failure: { cause: string; fix: string[]; details: string[] } })
      .failure
    expect(failure.cause).toBe("network")
    expect(failure.details[0]).toContain("self signed certificate")
    expect(failure.fix.join(" ")).toContain("--fingerprint")
  })

  it("classifies a refused pairing as auth and says the code is single-use", async () => {
    const result = await loginHost({
      endpoint: "https://h",
      invitation: "CODE",
      fetchConfig: async () => CONFIG as never,
      register: async () => {
        throw new Error("invitation_consumed")
      },
    })
    const failure = (result as { failure: { cause: string; fix: string[] } }).failure
    expect(failure.cause).toBe("auth")
    expect(failure.fix[0]).toContain("single-use")
  })
})
