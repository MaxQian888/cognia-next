/**
 * Tests for Plugin Permission Guard
 */

import {
  PermissionGuard,
  getPermissionGuard,
  resetPermissionGuard,
  PermissionError,
  createGuardedAPI,
  PERMISSION_GROUPS,
  PERMISSION_DESCRIPTIONS,
  DANGEROUS_PERMISSIONS,
} from "./permission-guard"
import type { PluginPermission as _PluginPermission } from "@/types/plugin"

describe("PermissionGuard", () => {
  let guard: PermissionGuard

  beforeEach(() => {
    resetPermissionGuard()
    guard = new PermissionGuard()
  })

  afterEach(() => {
    guard.clear()
  })

  describe("Plugin Registration", () => {
    it("should register a plugin with permissions", () => {
      guard.registerPlugin("plugin-a", ["network:fetch", "clipboard:read"])

      const permissions = guard.getPluginPermissions("plugin-a")
      expect(permissions).toContain("network:fetch")
      expect(permissions).toContain("clipboard:read")
    })

    it("should unregister a plugin", () => {
      guard.registerPlugin("plugin-a", ["network:fetch"])
      guard.unregisterPlugin("plugin-a")

      const permissions = guard.getPluginPermissions("plugin-a")
      expect(permissions).toEqual([])
    })
  })

  describe("Permission Checking", () => {
    beforeEach(() => {
      guard.registerPlugin("plugin-a", ["network:fetch", "clipboard:read"])
    })

    it("should return true for granted permissions", () => {
      expect(guard.check("plugin-a", "network:fetch")).toBe(true)
    })

    it("should return false for non-granted permissions", () => {
      expect(guard.check("plugin-a", "filesystem:write")).toBe(false)
    })

    it("should check multiple permissions", () => {
      expect(guard.checkMultiple("plugin-a", ["network:fetch", "clipboard:read"])).toBe(true)
      expect(guard.checkMultiple("plugin-a", ["network:fetch", "filesystem:write"])).toBe(false)
    })

    it("should check any permission", () => {
      expect(guard.checkAny("plugin-a", ["network:fetch", "filesystem:write"])).toBe(true)
      expect(guard.checkAny("plugin-a", ["filesystem:read", "filesystem:write"])).toBe(false)
    })
  })

  describe("Permission Requiring", () => {
    beforeEach(() => {
      guard.registerPlugin("plugin-a", ["network:fetch"])
    })

    it("should not throw for granted permissions", () => {
      expect(() => guard.require("plugin-a", "network:fetch")).not.toThrow()
    })

    it("should throw PermissionError for non-granted permissions", () => {
      expect(() => guard.require("plugin-a", "filesystem:write")).toThrow(PermissionError)
    })

    it("should throw with correct plugin and permission info", () => {
      try {
        guard.require("plugin-a", "filesystem:write")
        fail("Expected PermissionError to be thrown")
      } catch (error) {
        expect(error).toBeInstanceOf(PermissionError)
        expect((error as PermissionError).pluginId).toBe("plugin-a")
        expect((error as PermissionError).permission).toBe("filesystem:write")
      }
    })

    it("should require multiple permissions", () => {
      guard.registerPlugin("plugin-b", ["network:fetch", "clipboard:read"])

      expect(() =>
        guard.requireMultiple("plugin-b", ["network:fetch", "clipboard:read"])
      ).not.toThrow()

      expect(() =>
        guard.requireMultiple("plugin-b", ["network:fetch", "filesystem:write"])
      ).toThrow(PermissionError)
    })
  })

  describe("Permission Granting", () => {
    it("should grant permissions at runtime", () => {
      guard.registerPlugin("plugin-a", [])

      expect(guard.check("plugin-a", "network:fetch")).toBe(false)

      guard.grant("plugin-a", "network:fetch")

      expect(guard.check("plugin-a", "network:fetch")).toBe(true)
    })

    it("should grant with expiration", async () => {
      guard.registerPlugin("plugin-a", [])

      guard.grant("plugin-a", "network:fetch", { expiresIn: 50 })

      expect(guard.check("plugin-a", "network:fetch")).toBe(true)

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(guard.check("plugin-a", "network:fetch")).toBe(false)
    })

    it("should track grant source", () => {
      guard.registerPlugin("plugin-a", ["network:fetch"])
      guard.grant("plugin-a", "clipboard:read", { grantedBy: "user" })

      const grants = guard.getPluginGrants("plugin-a")

      const networkGrant = grants.find((g) => g.permission === "network:fetch")
      const clipboardGrant = grants.find((g) => g.permission === "clipboard:read")

      expect(networkGrant?.grantedBy).toBe("manifest")
      expect(clipboardGrant?.grantedBy).toBe("user")
    })
  })

  describe("Permission Revocation", () => {
    beforeEach(() => {
      guard.registerPlugin("plugin-a", ["network:fetch", "clipboard:read"])
    })

    it("should revoke a permission", () => {
      expect(guard.check("plugin-a", "network:fetch")).toBe(true)

      guard.revoke("plugin-a", "network:fetch")

      expect(guard.check("plugin-a", "network:fetch")).toBe(false)
    })

    it("should revoke multiple permissions", () => {
      guard.revokeMultiple("plugin-a", ["network:fetch", "clipboard:read"])

      expect(guard.check("plugin-a", "network:fetch")).toBe(false)
      expect(guard.check("plugin-a", "clipboard:read")).toBe(false)
    })

    it("should revoke all permissions", () => {
      guard.revokeAll("plugin-a")

      expect(guard.getPluginPermissions("plugin-a")).toEqual([])
    })
  })

  describe("Audit Logging", () => {
    beforeEach(() => {
      guard.registerPlugin("plugin-a", ["network:fetch"])
    })

    it("should log permission checks", () => {
      guard.check("plugin-a", "network:fetch")
      guard.check("plugin-a", "filesystem:write")

      const log = guard.getAuditLog({ pluginId: "plugin-a" })
      expect(log.length).toBeGreaterThan(0)
    })

    it("should filter audit log by action", () => {
      guard.check("plugin-a", "network:fetch")
      guard.grant("plugin-a", "clipboard:read")

      const checks = guard.getAuditLog({ action: "check" })
      const grants = guard.getAuditLog({ action: "grant" })

      expect(checks.length).toBeGreaterThan(0)
      expect(grants.length).toBeGreaterThan(0)
    })

    it("should clear audit log", () => {
      guard.check("plugin-a", "network:fetch")
      guard.clearAuditLog()

      expect(guard.getAuditLog().length).toBe(0)
    })
  })

  describe("Introspection", () => {
    it("should get all plugins with a permission", () => {
      guard.registerPlugin("plugin-a", ["network:fetch"])
      guard.registerPlugin("plugin-b", ["network:fetch", "clipboard:read"])
      guard.registerPlugin("plugin-c", ["clipboard:read"])

      const plugins = guard.getAllPluginsWithPermission("network:fetch")
      expect(plugins).toContain("plugin-a")
      expect(plugins).toContain("plugin-b")
      expect(plugins).not.toContain("plugin-c")
    })

    it("should identify dangerous permissions", () => {
      expect(guard.isDangerousPermission("shell:execute")).toBe(true)
      expect(guard.isDangerousPermission("network:fetch")).toBe(false)
    })

    it("should get permission descriptions", () => {
      const desc = guard.getPermissionDescription("network:fetch")
      expect(desc).toBeTruthy()
      expect(typeof desc).toBe("string")
    })
  })
})

describe("createGuardedAPI", () => {
  let guard: PermissionGuard

  beforeEach(() => {
    resetPermissionGuard()
    guard = getPermissionGuard()
    guard.registerPlugin("plugin-a", ["network:fetch"])
  })

  it("should create a guarded API", () => {
    const api = {
      fetchData: () => "data",
      writeFile: () => "written",
    }

    const guarded = createGuardedAPI("plugin-a", api, {
      fetchData: "network:fetch",
      writeFile: "filesystem:write",
    })

    expect(guarded.fetchData()).toBe("data")
    expect(() => guarded.writeFile()).toThrow(PermissionError)
  })

  it("should allow methods without permission mapping", () => {
    const api = {
      publicMethod: () => "public",
      protectedMethod: () => "protected",
    }

    const guarded = createGuardedAPI("plugin-a", api, {
      protectedMethod: "filesystem:write",
    })

    expect(guarded.publicMethod()).toBe("public")
  })
})

describe("Permission Constants", () => {
  it("should have permission groups", () => {
    expect(PERMISSION_GROUPS.filesystem).toContain("filesystem:read")
    expect(PERMISSION_GROUPS.filesystem).toContain("filesystem:write")
    expect(PERMISSION_GROUPS.network).toContain("network:fetch")
  })

  it("should have permission descriptions", () => {
    expect(PERMISSION_DESCRIPTIONS["network:fetch"]).toBeTruthy()
    expect(PERMISSION_DESCRIPTIONS["filesystem:write"]).toBeTruthy()
  })

  it("should have dangerous permissions list", () => {
    expect(DANGEROUS_PERMISSIONS).toContain("shell:execute")
    expect(DANGEROUS_PERMISSIONS).toContain("process:spawn")
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPermissionGuard()
    const instance1 = getPermissionGuard()
    const instance2 = getPermissionGuard()
    expect(instance1).toBe(instance2)
  })
})
