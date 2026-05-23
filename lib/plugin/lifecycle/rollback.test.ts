/**
 * Tests for Plugin Rollback Manager
 */

import {
  PluginRollbackManager,
  getPluginRollbackManager,
  resetPluginRollbackManager,
} from "./rollback"

const mockInvoke = jest.fn()
const mockGetBackups = jest.fn()
const mockCreateBackup = jest.fn()
const mockRestoreToVersion = jest.fn()
const mockGetVersions = jest.fn()
const mockInstallPlugin = jest.fn()
const mockStoreGetState = jest.fn()
const mockStoreSetState = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

jest.mock("./backup", () => ({
  getPluginBackupManager: () => ({
    getBackups: (...args: unknown[]) => mockGetBackups(...args),
    createBackup: (...args: unknown[]) => mockCreateBackup(...args),
    restoreToVersion: (...args: unknown[]) => mockRestoreToVersion(...args),
  }),
}))

jest.mock("../package/marketplace", () => ({
  getPluginMarketplace: () => ({
    getVersions: (...args: unknown[]) => mockGetVersions(...args),
    installPlugin: (...args: unknown[]) => mockInstallPlugin(...args),
  }),
}))

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: (...args: unknown[]) => mockStoreGetState(...args),
    setState: (...args: unknown[]) => mockStoreSetState(...args),
  },
}))

jest.mock("../core/logger", () => ({
  loggers: {
    manager: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  },
}))

type MockStoreState = {
  plugins: Record<
    string,
    { manifest: { id: string; version: string }; config: Record<string, unknown> }
  >
  setPluginConfig: jest.Mock
}

describe("PluginRollbackManager", () => {
  let manager: PluginRollbackManager
  let storeState: MockStoreState

  beforeEach(() => {
    resetPluginRollbackManager()
    manager = new PluginRollbackManager()
    jest.clearAllMocks()

    storeState = {
      plugins: {
        "plugin-a": {
          manifest: { id: "plugin-a", version: "2.0.0" },
          config: {},
        },
      },
      setPluginConfig: jest.fn(),
    }

    mockStoreGetState.mockImplementation(() => storeState)
    mockStoreSetState.mockImplementation((next) => {
      if (typeof next === "function") {
        const patch = next(storeState)
        if (patch && typeof patch === "object") {
          Object.assign(storeState, patch)
        }
      } else if (next && typeof next === "object") {
        Object.assign(storeState, next)
      }
    })

    mockGetBackups.mockReturnValue([])
    mockCreateBackup.mockResolvedValue({ success: true })
    mockRestoreToVersion.mockResolvedValue({ success: true })
    mockGetVersions.mockResolvedValue([])
    mockInstallPlugin.mockResolvedValue({ success: true })
    mockInvoke.mockResolvedValue(null)
  })

  describe("getRollbackInfo", () => {
    it("should get rollback info with backups", async () => {
      mockGetBackups.mockReturnValue([
        { pluginId: "plugin-a", version: "1.0.0", createdAt: new Date(), size: 1000 },
        { pluginId: "plugin-a", version: "1.5.0", createdAt: new Date(), size: 1200 },
      ])

      const info = await manager.getRollbackInfo("plugin-a")

      expect(info.pluginId).toBe("plugin-a")
      expect(info.currentVersion).toBe("2.0.0")
      expect(info.availableVersions.length).toBe(2)
      expect(info.hasBackups).toBe(true)
    })

    it("should indicate when no backups available", async () => {
      mockGetBackups.mockReturnValue([])
      const info = await manager.getRollbackInfo("plugin-a")
      expect(info.hasBackups).toBe(false)
      expect(info.availableVersions.length).toBe(0)
    })

    it("should fall back to unknown when plugin is not in store", async () => {
      storeState.plugins = {}
      const info = await manager.getRollbackInfo("missing-plugin")
      expect(info.currentVersion).toBe("unknown")
    })
  })

  describe("createRollbackPlan", () => {
    it("should create a rollback plan with steps", async () => {
      mockGetBackups.mockReturnValue([
        { pluginId: "plugin-a", version: "1.0.0", createdAt: new Date(), size: 1000 },
      ])

      const plan = await manager.createRollbackPlan("plugin-a", "1.0.0")

      expect(plan.pluginId).toBe("plugin-a")
      expect(plan.targetVersion).toBe("1.0.0")
      expect(plan.steps.length).toBeGreaterThan(0)
    })

    it("should throw for unavailable target version", async () => {
      await expect(manager.createRollbackPlan("plugin-a", "1.0.0")).rejects.toThrow(
        "Version 1.0.0 is not available for rollback"
      )
    })
  })

  describe("rollback", () => {
    it("should attempt rollback with backup available", async () => {
      mockGetBackups.mockReturnValue([
        {
          pluginId: "plugin-a",
          version: "1.0.0",
          createdAt: new Date(),
          size: 1000,
          path: "/backup/1.0.0",
        },
      ])

      const result = await manager.rollback("plugin-a", "1.0.0")
      expect(result.success).toBe(true)
      expect(result.toVersion).toBe("1.0.0")
    })

    it("should handle rollback failure", async () => {
      mockInstallPlugin.mockResolvedValueOnce({ success: false, error: "install failed" })
      const result = await manager.rollback("plugin-a", "1.0.0")
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe("rollbackToLatestBackup", () => {
    it("should rollback to latest backup version", async () => {
      mockGetBackups.mockReturnValue([
        {
          pluginId: "plugin-a",
          version: "1.5.0",
          createdAt: new Date(),
          size: 1200,
          path: "/backup/1.5.0",
        },
        {
          pluginId: "plugin-a",
          version: "1.0.0",
          createdAt: new Date(Date.now() - 10000),
          size: 1000,
          path: "/backup/1.0.0",
        },
      ])

      const result = await manager.rollbackToLatestBackup("plugin-a")
      expect(result.success).toBe(true)
      expect(result.toVersion).toBe("1.5.0")
    })

    it("should fail if no backups available", async () => {
      mockGetBackups.mockReturnValue([])
      const result = await manager.rollbackToLatestBackup("plugin-a")
      expect(result.success).toBe(false)
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginRollbackManager()
    const instance1 = getPluginRollbackManager()
    const instance2 = getPluginRollbackManager()
    expect(instance1).toBe(instance2)
  })
})
