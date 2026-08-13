import { preflightConnectorConfig } from "./config-preflight"

describe("preflightConnectorConfig", () => {
  it("strictly probes supported platforms before the caller mutates state", async () => {
    const probe = jest.fn().mockResolvedValue({ ok: true })
    await expect(preflightConnectorConfig({ probe })).resolves.toEqual({
      verification: "verified",
      missingOptionalScopes: [],
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("preserves the caller's old state by rejecting a failed candidate", async () => {
    await expect(
      preflightConnectorConfig({ probe: async () => ({ ok: false, error: "unauthorized" }) })
    ).rejects.toThrow("unauthorized")
  })

  it("marks reverse/no-probe connections pending and reports optional degradation", async () => {
    await expect(
      preflightConnectorConfig({
        grantedScopes: ["chat:read"],
        requiredScopes: ["chat:read"],
        optionalScopes: ["chat:write"],
      })
    ).resolves.toEqual({ verification: "pending", missingOptionalScopes: ["chat:write"] })
  })

  it("blocks enablement when required scopes are missing", async () => {
    await expect(
      preflightConnectorConfig({ grantedScopes: [], requiredScopes: ["chat:write"] })
    ).rejects.toThrow("chat:write")
  })
})
