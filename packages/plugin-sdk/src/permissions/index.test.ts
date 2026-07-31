import type {
  PluginPermission,
  PluginPermissionDecision,
  PluginPermissionPolicy,
  PluginAPIPermission,
} from "./index"

describe("plugin-sdk: permissions", () => {
  it("re-exports the manifest-declared permission identifier union", () => {
    const perms: PluginPermission[] = []
    expect(perms).toEqual([])
  })

  it("re-exports the decision + policy unions", () => {
    const policy: PluginPermissionPolicy = "ask"
    const decision: PluginPermissionDecision = "allow"
    expect(policy).toBe("ask")
    expect(decision).toBe("allow")
  })

  it("re-exports the complete permission union", () => {
    const apiPerms: PluginAPIPermission[] = []
    expect(apiPerms).toEqual([])
  })
})
