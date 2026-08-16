import { intersectPluginPolicyOverlay, realmLookupOrder, validatePluginRealmId } from "./realm"

describe("plugin realms", () => {
  it("resolves session then project then global", () => {
    expect(realmLookupOrder({ realmId: "session:s1", projectId: "p1" })).toEqual([
      "session:s1",
      "project:p1",
      "global",
    ])
    expect(realmLookupOrder({ realmId: "project:p1" })).toEqual(["project:p1", "global"])
  })

  it("rejects unsupported realm ids", () => {
    expect(validatePluginRealmId("global")).toBe("global")
    expect(() => validatePluginRealmId("workspace:p1")).toThrow("Unsupported plugin realm")
  })

  it("only tightens permissions, allowlists, quotas, consent, config, and secrets", () => {
    expect(
      intersectPluginPolicyOverlay(
        {
          permissions: ["network", "storage", "shell"],
          networkAllowlist: ["api.example.com", "cdn.example.com"],
          quotas: { calls: 100, bytes: 1_000 },
          consent: ["network", "shell"],
          configKeys: ["model", "endpoint"],
          secretKeys: ["api-key"],
        },
        {
          permissions: ["network", "unknown"],
          networkAllowlist: ["api.example.com", "evil.example.com"],
          quotas: { calls: 10, bytes: 2_000 },
          consent: ["network"],
          configKeys: ["model"],
          secretKeys: ["missing"],
        }
      )
    ).toEqual({
      permissions: ["network"],
      networkAllowlist: ["api.example.com"],
      quotas: { calls: 10, bytes: 1_000 },
      consent: ["network"],
      configKeys: ["model"],
      secretKeys: [],
    })
  })
})
