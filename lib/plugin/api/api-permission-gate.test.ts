/**
 * Tests for the PluginAPIPermission-space guard proxy.
 */

import { createApiGuardedAPI, hasApiOrGuardPermission } from "./api-permission-gate"
import { initializePluginPermissions, revokePluginPermissions } from "./permission-api"
import { getPermissionGuard, PermissionError } from "@/lib/plugin/security/permission-guard"

jest.mock("@/lib/plugin/core/transport", () => ({
  grantPluginPermission: jest.fn().mockResolvedValue(undefined),
  listPluginPermissions: jest.fn().mockResolvedValue([]),
  revokePluginPermission: jest.fn().mockResolvedValue(undefined),
}))

describe("createApiGuardedAPI", () => {
  const pluginId = "gate-test"
  const api = {
    read: jest.fn(() => "read-ok"),
    write: jest.fn(() => "write-ok"),
    helper: jest.fn(() => "helper-ok"),
    unmapped: jest.fn(() => "unmapped-ok"),
    version: "1.0",
  }

  const guarded = createApiGuardedAPI(
    pluginId,
    api,
    { read: "vector:read", write: "vector:write" },
    { unguarded: ["helper"] }
  )

  afterEach(() => {
    revokePluginPermissions(pluginId)
    getPermissionGuard().unregisterPlugin(pluginId)
    jest.clearAllMocks()
  })

  it("throws PermissionError when the permission is not granted", () => {
    expect(() => guarded.read()).toThrow(PermissionError)
    expect(api.read).not.toHaveBeenCalled()
  })

  it("passes through when the API-permission store grants it", () => {
    initializePluginPermissions(pluginId, ["vector:read"])
    expect(guarded.read()).toBe("read-ok")
    expect(() => guarded.write()).toThrow(PermissionError)
  })

  it("passes through when the PermissionGuard grants the same string", () => {
    getPermissionGuard().registerPlugin(pluginId, [
      "vector:write" as unknown as import("@/types/plugin").PluginPermission,
    ])
    expect(guarded.write()).toBe("write-ok")
  })

  it("never gates unguarded methods", () => {
    expect(guarded.helper()).toBe("helper-ok")
  })

  it("fails closed on unmapped methods even with every permission granted", () => {
    initializePluginPermissions(pluginId, ["vector:read", "vector:write"])
    expect(() => guarded.unmapped()).toThrow(/not permission-mapped/)
    expect(api.unmapped).not.toHaveBeenCalled()
  })

  it("passes non-function properties through", () => {
    expect(guarded.version).toBe("1.0")
  })

  it("preserves arguments and this-binding on guarded calls", () => {
    initializePluginPermissions(pluginId, ["vector:write"])
    const spy = jest.fn(function (this: unknown, a: number, b: number) {
      return a + b
    })
    const g = createApiGuardedAPI(pluginId, { add: spy }, { add: "vector:write" })
    expect(g.add(2, 3)).toBe(5)
    expect(spy).toHaveBeenCalledWith(2, 3)
  })
})

describe("hasApiOrGuardPermission", () => {
  const pluginId = "gate-check"

  afterEach(() => {
    revokePluginPermissions(pluginId)
    getPermissionGuard().unregisterPlugin(pluginId)
  })

  it("is false with no grant anywhere", () => {
    expect(hasApiOrGuardPermission(pluginId, "ai:chat")).toBe(false)
  })

  it("honours the default API grants (theme:read)", () => {
    initializePluginPermissions(pluginId, [])
    expect(hasApiOrGuardPermission(pluginId, "theme:read")).toBe(true)
    expect(hasApiOrGuardPermission(pluginId, "theme:write")).toBe(false)
  })
})
