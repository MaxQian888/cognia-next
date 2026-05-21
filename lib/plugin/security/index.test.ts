import * as security from "./index"

describe("lib/plugin/security barrel", () => {
  it.each([
    "PermissionGuard",
    "getPermissionGuard",
    "resetPermissionGuard",
    "PermissionError",
    "createGuardedAPI",
    "PluginSignatureVerifier",
    "getPluginSignatureVerifier",
    "resetPluginSignatureVerifier",
  ])("exports %s as a function or class", (name) => {
    const sym = (security as Record<string, unknown>)[name]
    expect(typeof sym).toBe("function")
  })

  it.each(["PERMISSION_GROUPS", "PERMISSION_DESCRIPTIONS", "DANGEROUS_PERMISSIONS"])(
    "exports %s as a non-empty constant",
    (name) => {
      const sym = (security as Record<string, unknown>)[name]
      expect(sym).toBeDefined()
      if (Array.isArray(sym)) {
        expect(sym.length).toBeGreaterThan(0)
      } else if (typeof sym === "object" && sym !== null) {
        expect(Object.keys(sym).length).toBeGreaterThan(0)
      }
    }
  )

  it("getPermissionGuard returns an instance of PermissionGuard", () => {
    const guard = security.getPermissionGuard()
    expect(guard).toBeInstanceOf(security.PermissionGuard)
    security.resetPermissionGuard()
  })
})
