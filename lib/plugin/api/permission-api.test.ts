/**
 * Tests for Permission Plugin API
 */

import {
  createPermissionAPI,
  initializePluginPermissions,
  revokePluginPermissions,
  grantPermission,
  revokePermission,
  pluginHasApiPermission,
} from "./permission-api"
import type { PluginAPIPermission } from "@/types/plugin/plugin"
import { requestPluginPermission } from "@/lib/plugin/security/permission-requests"

jest.mock("@/lib/plugin/security/permission-requests", () => ({
  requestPluginPermission: jest.fn(),
}))
jest.mock("@/lib/plugin/core/transport", () => ({
  grantPluginPermission: jest.fn().mockResolvedValue(undefined),
  listPluginPermissions: jest.fn().mockResolvedValue([]),
  revokePluginPermission: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("../contracts/diagnostics-store", () => ({
  recordSilentFailure: jest.fn(),
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const transport = require("@/lib/plugin/core/transport") as {
  grantPluginPermission: jest.Mock
  listPluginPermissions: jest.Mock
  revokePluginPermission: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const diag = require("../contracts/diagnostics-store") as {
  recordSilentFailure: jest.Mock
}

describe("Permission API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    // Revoke all permissions before each test
    revokePluginPermissions(testPluginId)
    ;(requestPluginPermission as jest.Mock).mockReset()
    transport.grantPluginPermission.mockReset().mockResolvedValue(undefined)
    transport.listPluginPermissions.mockReset().mockResolvedValue([])
    transport.revokePluginPermission.mockReset().mockResolvedValue(undefined)
    diag.recordSilentFailure.mockReset()
  })

  describe("createPermissionAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createPermissionAPI(testPluginId, [])

      expect(api).toBeDefined()
      expect(typeof api.hasPermission).toBe("function")
      expect(typeof api.requestPermission).toBe("function")
      expect(typeof api.getGrantedPermissions).toBe("function")
      expect(typeof api.hasAllPermissions).toBe("function")
      expect(typeof api.hasAnyPermission).toBe("function")
    })
  })

  describe("initializePluginPermissions", () => {
    it("should grant default permissions", () => {
      initializePluginPermissions(testPluginId, [])
      const api = createPermissionAPI(testPluginId, [])

      // notification:show and theme:read are default permissions
      expect(api.hasPermission("notification:show")).toBe(true)
      expect(api.hasPermission("theme:read")).toBe(true)
    })

    it("should map manifest permissions to API permissions", () => {
      initializePluginPermissions(testPluginId, ["session:read", "session:write"])
      const api = createPermissionAPI(testPluginId, ["session:read", "session:write"])

      expect(api.hasPermission("session:read")).toBe(true)
      expect(api.hasPermission("session:write")).toBe(true)
    })

    it("should grant inter-plugin IPC permissions declared in the manifest", () => {
      // Regression: `ipc:call` / `ipc:expose` were missing from the mapping,
      // so a plugin could declare them but `ctx.ipc.*` would always throw.
      initializePluginPermissions(testPluginId, ["ipc:call", "ipc:expose"])

      expect(pluginHasApiPermission(testPluginId, "ipc:call")).toBe(true)
      expect(pluginHasApiPermission(testPluginId, "ipc:expose")).toBe(true)
    })
  })

  describe("hasPermission", () => {
    it("should return true for granted permission", () => {
      const api = createPermissionAPI(testPluginId, ["artifact:read"])

      expect(api.hasPermission("artifact:read")).toBe(true)
    })

    it("should return false for non-granted permission", () => {
      const api = createPermissionAPI(testPluginId, [])

      expect(api.hasPermission("artifact:write")).toBe(false)
    })
  })

  describe("requestPermission", () => {
    it("should grant requested permission", async () => {
      const api = createPermissionAPI(testPluginId, [])

      expect(api.hasPermission("canvas:write")).toBe(false)
      ;(requestPluginPermission as jest.Mock).mockResolvedValue(true)
      const granted = await api.requestPermission("canvas:write", "Need to edit canvas")

      expect(granted).toBe(true)
      expect(api.hasPermission("canvas:write")).toBe(true)
      expect(requestPluginPermission).toHaveBeenCalledWith({
        pluginId: testPluginId,
        permission: "canvas:write",
        reason: "Need to edit canvas",
        kind: "api",
      })
    })

    it("should deny permission when request is rejected", async () => {
      const api = createPermissionAPI(testPluginId, [])

      ;(requestPluginPermission as jest.Mock).mockResolvedValue(false)
      const granted = await api.requestPermission("artifact:write", "Need to update artifact")

      expect(granted).toBe(false)
      expect(api.hasPermission("artifact:write")).toBe(false)
    })
  })

  describe("getGrantedPermissions", () => {
    it("should return all granted permissions", () => {
      const api = createPermissionAPI(testPluginId, ["session:read", "project:read", "vector:read"])

      const granted = api.getGrantedPermissions()

      expect(Array.isArray(granted)).toBe(true)
      expect(granted).toContain("session:read")
      expect(granted).toContain("project:read")
      expect(granted).toContain("vector:read")
      // Also includes default permissions
      expect(granted).toContain("notification:show")
      expect(granted).toContain("theme:read")
    })
  })

  describe("hasAllPermissions", () => {
    it("should return true when all permissions are granted", () => {
      const api = createPermissionAPI(testPluginId, [
        "session:read",
        "session:write",
        "session:delete",
      ])

      const result = api.hasAllPermissions(["session:read", "session:write"])

      expect(result).toBe(true)
    })

    it("should return false when some permissions are missing", () => {
      const api = createPermissionAPI(testPluginId, ["session:read"])

      const result = api.hasAllPermissions(["session:read", "session:write"])

      expect(result).toBe(false)
    })

    it("should return true for empty array", () => {
      const api = createPermissionAPI(testPluginId, [])

      const result = api.hasAllPermissions([])

      expect(result).toBe(true)
    })
  })

  describe("hasAnyPermission", () => {
    it("should return true when at least one permission is granted", () => {
      const api = createPermissionAPI(testPluginId, ["session:read"])

      const result = api.hasAnyPermission(["session:read", "session:write", "session:delete"])

      expect(result).toBe(true)
    })

    it("should return false when no permissions are granted", () => {
      const api = createPermissionAPI(testPluginId, [])

      const result = api.hasAnyPermission(["canvas:write", "artifact:write"])

      expect(result).toBe(false)
    })

    it("should return false for empty array", () => {
      const api = createPermissionAPI(testPluginId, ["session:read"])

      const result = api.hasAnyPermission([])

      expect(result).toBe(false)
    })
  })

  describe("grantPermission", () => {
    it("should grant a specific permission to a plugin", () => {
      const api = createPermissionAPI(testPluginId, [])

      expect(api.hasPermission("export:session")).toBe(false)

      grantPermission(testPluginId, "export:session")

      expect(api.hasPermission("export:session")).toBe(true)
    })
  })

  describe("revokePermission", () => {
    it("should revoke a specific permission from a plugin", () => {
      const api = createPermissionAPI(testPluginId, ["ai:chat"])

      expect(api.hasPermission("ai:chat")).toBe(true)

      revokePermission(testPluginId, "ai:chat")

      expect(api.hasPermission("ai:chat")).toBe(false)
    })
  })

  describe("revokePluginPermissions", () => {
    it("should revoke all permissions for a plugin", () => {
      const api = createPermissionAPI(testPluginId, ["session:read", "project:read", "vector:read"])

      const grantedBefore = api.getGrantedPermissions()
      expect(grantedBefore.length).toBeGreaterThan(0)

      revokePluginPermissions(testPluginId)

      // After revoking, creating a new API should not have any permissions
      // until initialized again
      const api2 = createPermissionAPI(testPluginId, [])
      const grantedAfter = api2.getGrantedPermissions()

      // Should have default permissions only
      expect(grantedAfter).toContain("notification:show")
      expect(grantedAfter).toContain("theme:read")
    })
  })

  describe("pluginHasApiPermission", () => {
    it("returns false for a plugin with no initialised permission set", () => {
      revokePluginPermissions("ghost-plugin")
      expect(pluginHasApiPermission("ghost-plugin", "agent:control")).toBe(false)
    })

    it("returns true once the manifest permission maps in", () => {
      initializePluginPermissions("agent-plugin", ["agent:control", "agent:dispatch-external"])
      expect(pluginHasApiPermission("agent-plugin", "agent:control")).toBe(true)
      expect(pluginHasApiPermission("agent-plugin", "agent:dispatch-external")).toBe(true)
    })

    it("returns false for a permission the plugin did not declare", () => {
      initializePluginPermissions("narrow-plugin", ["session:read"])
      expect(pluginHasApiPermission("narrow-plugin", "agent:control")).toBe(false)
    })
  })

  describe("Permission isolation", () => {
    it("should isolate permissions between plugins", () => {
      const api1 = createPermissionAPI("plugin-1", ["session:read", "session:write"])
      const api2 = createPermissionAPI("plugin-2", ["project:read"])

      expect(api1.hasPermission("session:read")).toBe(true)
      expect(api1.hasPermission("project:read")).toBe(false)

      expect(api2.hasPermission("session:read")).toBe(false)
      expect(api2.hasPermission("project:read")).toBe(true)

      // Cleanup
      revokePluginPermissions("plugin-1")
      revokePluginPermissions("plugin-2")
    })
  })

  describe("Silent-failure routing (ADR-0016 T1)", () => {
    it("routes listPluginPermissions failure through recordSilentFailure", async () => {
      transport.listPluginPermissions.mockRejectedValueOnce(new Error("transport down"))
      createPermissionAPI("p-list", [])
      await Promise.resolve()
      await Promise.resolve()
      expect(diag.recordSilentFailure).toHaveBeenCalledWith(
        "p-list",
        expect.objectContaining({ site: "permission.listHost", expected: false }),
        expect.any(Error)
      )
    })

    it("routes requestPermission host-grant failure through recordSilentFailure", async () => {
      transport.grantPluginPermission.mockRejectedValueOnce(new Error("persist failed"))
      ;(requestPluginPermission as jest.Mock).mockResolvedValue(true)
      const api = createPermissionAPI("p-req", [])
      const granted = await api.requestPermission("canvas:write", "test")
      expect(granted).toBe(true)
      await Promise.resolve()
      await Promise.resolve()
      expect(diag.recordSilentFailure).toHaveBeenCalledWith(
        "p-req",
        expect.objectContaining({
          site: "permission.grantHost",
          message: expect.stringContaining("canvas:write"),
        }),
        expect.any(Error)
      )
    })

    it("routes grantPermission failure through recordSilentFailure", async () => {
      transport.grantPluginPermission.mockRejectedValueOnce(new Error("grant failed"))
      grantPermission("p-grant", "vector:write")
      await Promise.resolve()
      await Promise.resolve()
      expect(diag.recordSilentFailure).toHaveBeenCalledWith(
        "p-grant",
        expect.objectContaining({ site: "permission.grantHost" }),
        expect.any(Error)
      )
    })

    it("routes revokePermission failure through recordSilentFailure", async () => {
      transport.revokePluginPermission.mockRejectedValueOnce(new Error("revoke failed"))
      revokePermission("p-rev", "ai:chat")
      await Promise.resolve()
      await Promise.resolve()
      expect(diag.recordSilentFailure).toHaveBeenCalledWith(
        "p-rev",
        expect.objectContaining({ site: "permission.revokeHost" }),
        expect.any(Error)
      )
    })
  })

  describe("Permission types", () => {
    it("should handle all API permission types", () => {
      const allPermissions: PluginAPIPermission[] = [
        "session:read",
        "session:write",
        "session:delete",
        "project:read",
        "project:write",
        "project:delete",
        "vector:read",
        "vector:write",
        "canvas:read",
        "canvas:write",
        "artifact:read",
        "artifact:write",
        "ai:chat",
        "ai:embed",
        "export:session",
        "export:project",
        "theme:read",
        "theme:write",
        "media:image:read",
        "media:image:write",
        "media:video:read",
        "media:video:write",
        "media:video:export",
        "extension:ui",
        "notification:show",
      ]

      const api = createPermissionAPI(testPluginId, allPermissions)

      for (const perm of allPermissions) {
        expect(api.hasPermission(perm)).toBe(true)
      }
    })
  })
})
