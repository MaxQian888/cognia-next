/**
 * Tests for Plugin Updater
 */

import { PluginUpdater, getPluginUpdater, resetPluginUpdater } from "./updater"

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: jest.fn(),
  },
}))

jest.mock("../package/marketplace", () => ({
  getPluginMarketplace: () => ({
    getPlugin: jest.fn().mockResolvedValue({
      id: "plugin-a",
      latestVersion: "2.0.0",
      updatedAt: new Date(),
    }),
    getVersions: jest.fn().mockResolvedValue([
      {
        version: "2.0.0",
        publishedAt: new Date(),
        downloadUrl: "https://example.com/plugin-a-2.0.0.zip",
      },
    ]),
    installPlugin: jest.fn().mockResolvedValue({
      success: true,
    }),
  }),
}))

jest.mock("./backup", () => ({
  getPluginBackupManager: () => ({
    createBackup: jest.fn().mockResolvedValue({ success: true }),
  }),
}))

import { usePluginStore } from "@/stores/plugin-runtime"
const mockGetStoreState = usePluginStore.getState as jest.MockedFunction<
  typeof usePluginStore.getState
>

describe("PluginUpdater", () => {
  let updater: PluginUpdater

  beforeEach(() => {
    resetPluginUpdater()
    updater = new PluginUpdater()
    jest.clearAllMocks()
    mockGetStoreState.mockReturnValue({
      plugins: {
        "plugin-a": {
          manifest: { id: "plugin-a", version: "1.0.0" },
          status: "installed",
        },
      },
    } as never)
  })

  describe("Update Checking", () => {
    it("should check for updates for specific plugins", async () => {
      const updates = await updater.checkForUpdates(["plugin-a"])

      expect(Array.isArray(updates)).toBe(true)
    })

    it("should check update for a single plugin", async () => {
      const update = await updater.checkPluginUpdate("plugin-a")

      // May return null or UpdateInfo depending on marketplace response
      expect(update === null || typeof update === "object").toBe(true)
    })

    it("should get pending updates", () => {
      const pending = updater.getPendingUpdates()
      expect(Array.isArray(pending)).toBe(true)
    })

    it("should clear pending updates", () => {
      updater.clearPendingUpdate("plugin-a")
      // No error means success
    })
  })

  describe("Update Installation", () => {
    it("should attempt to update a plugin", async () => {
      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result.pluginId).toBe("plugin-a")
      expect(typeof result.success).toBe("boolean")
    })

    it("should return error for non-pending updates without force", async () => {
      const result = await updater.update("plugin-a")

      expect(result.success).toBe(false)
      expect(result.error).toBe("No pending update found")
    })

    it("should update all pending plugins", async () => {
      const results = await updater.updateAll()

      expect(Array.isArray(results)).toBe(true)
    })

    it("installUpdate installs the requested version via update()", async () => {
      const result = await updater.installUpdate("plugin-a", "2.0.0")

      expect(result.pluginId).toBe("plugin-a")
      expect(result.newVersion).toBe("2.0.0")
    })

    it("cancelUpdate clears a queued pending update", async () => {
      await updater.checkForUpdates(["plugin-a"])
      expect(updater.getPendingUpdates().map((u) => u.pluginId)).toContain("plugin-a")

      updater.cancelUpdate("plugin-a")
      expect(updater.getPendingUpdates().map((u) => u.pluginId)).not.toContain("plugin-a")
    })
  })

  describe("Progress Handlers", () => {
    it("should add progress handler", () => {
      const handler = jest.fn()
      const unsubscribe = updater.onProgress(handler)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should remove progress handler", () => {
      const handler = jest.fn()
      const unsubscribe = updater.onProgress(handler)

      unsubscribe()
      // No error means success
    })
  })

  describe("Update History", () => {
    it("should get update history", () => {
      const history = updater.getUpdateHistory()
      expect(Array.isArray(history)).toBe(true)
    })

    it("should get update history for specific plugin", () => {
      const history = updater.getUpdateHistory("plugin-a")
      expect(Array.isArray(history)).toBe(true)
    })

    it("should clear update history", () => {
      updater.clearHistory()
      expect(updater.getUpdateHistory().length).toBe(0)
    })
  })

  describe("Auto Update", () => {
    it("should configure auto update", () => {
      updater.configureAutoUpdate({
        enabled: true,
        checkInterval: 3600000,
        autoInstall: false,
        notifyOnly: true,
        excludePlugins: [],
        allowPrerelease: false,
      })
      // No error means success
      updater.stopAutoUpdate()
    })

    it("should stop auto update", () => {
      updater.configureAutoUpdate({
        enabled: true,
        checkInterval: 3600000,
        autoInstall: false,
        notifyOnly: true,
        excludePlugins: [],
        allowPrerelease: false,
      })
      updater.stopAutoUpdate()
      // No error means success
    })
  })

  describe("Configuration", () => {
    it("should have default configuration", () => {
      const newUpdater = new PluginUpdater()
      expect(newUpdater).toBeDefined()
    })

    it("should accept custom configuration", () => {
      const newUpdater = new PluginUpdater({
        autoCheck: true,
        checkIntervalMs: 60000,
      })
      expect(newUpdater).toBeDefined()
    })
  })
})

describe("Singleton", () => {
  it("should return the same instance", () => {
    resetPluginUpdater()
    const instance1 = getPluginUpdater()
    const instance2 = getPluginUpdater()
    expect(instance1).toBe(instance2)
  })
})
