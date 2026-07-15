/**
 * Tests for Plugin Updater
 */

import { PluginUpdater, getPluginUpdater, resetPluginUpdater } from "./updater"

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: jest.fn(),
  },
}))

// Defined inside the factory (jest.mock factories hit the TDZ otherwise) and
// re-imported below so assertions can reach the spy.
jest.mock("../package/marketplace", () => {
  const getPlugin = jest.fn().mockResolvedValue({
    id: "plugin-a",
    latestVersion: "2.0.0",
    updatedAt: new Date(),
  })
  return {
    __getPluginSpy: getPlugin,
    getPluginMarketplace: () => ({
      getPlugin,
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
  }
})

jest.mock("@/lib/plugin/vscode-shim/openvsx-client", () => ({
  getOpenVsxClient: jest.fn(),
}))

jest.mock("@/lib/plugin/vscode-shim/openvsx-cache", () => ({
  getCached: jest.fn(),
  putCached: jest.fn(async () => undefined),
  cacheRowFromQueryEntry: jest.fn((entry: unknown) => entry),
}))

jest.mock("./backup", () => ({
  getPluginBackupManager: () => ({
    createBackup: jest.fn().mockResolvedValue({ success: true }),
  }),
}))

import { usePluginStore } from "@/stores/plugin-runtime"
import { getOpenVsxClient } from "@/lib/plugin/vscode-shim/openvsx-client"
import { getCached, putCached } from "@/lib/plugin/vscode-shim/openvsx-cache"

const marketplaceModule = jest.requireMock("../package/marketplace") as {
  __getPluginSpy: jest.Mock
}
const cogniaGetPlugin = marketplaceModule.__getPluginSpy
const getOpenVsxClientMock = getOpenVsxClient as jest.Mock
const getCachedMock = getCached as jest.Mock
const putCachedMock = putCached as jest.Mock

const mockGetStoreState = usePluginStore.getState as jest.MockedFunction<
  typeof usePluginStore.getState
>

/** A store entry shaped like the runtime's `PluginRegistration`. */
function storePlugin(manifest: Record<string, unknown>) {
  return { manifest, status: "installed" }
}

describe("PluginUpdater", () => {
  let updater: PluginUpdater

  beforeEach(() => {
    resetPluginUpdater()
    updater = new PluginUpdater()
    jest.clearAllMocks()
    cogniaGetPlugin.mockResolvedValue({
      id: "plugin-a",
      latestVersion: "2.0.0",
      updatedAt: new Date(),
    })
    getCachedMock.mockResolvedValue(undefined)
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

  describe("Open VSX routing", () => {
    /**
     * A query client returning one stable version. The parameter is typed so
     * `mock.calls[0][0]` is reachable — an untyped `jest.fn(async () => …)`
     * infers a zero-length tuple and the assertions won't compile.
     */
    function fakeOpenVsxClient(version = "2.0.0") {
      const queryExtension = jest.fn(
        async (_opts: { extensionId: string; targetPlatform?: string }) => ({
          offset: 0,
          totalSize: 1,
          extensions: [{ namespace: "esbenp", name: "prettier-vscode", version, files: {} }],
        })
      )
      getOpenVsxClientMock.mockReturnValue({ queryExtension })
      return queryExtension
    }

    it("vscode_extensions_are_not_queried_against_cognia_registry", async () => {
      // The bug this fixes: the old loop called marketplace.getPlugin() for
      // every installed plugin regardless of type, so Open VSX extension ids
      // were being sent to cognia's registry — an information leak that also
      // never returned anything.
      const queryExtension = fakeOpenVsxClient("2.0.0")
      mockGetStoreState.mockReturnValue({
        plugins: {
          "plugin-a": storePlugin({ id: "plugin-a", version: "1.0.0", type: "frontend" }),
          "esbenp.prettier-vscode": storePlugin({
            id: "esbenp.prettier-vscode",
            version: "1.0.0",
            type: "vscode-extension",
            vscodeExtension: { identifier: "esbenp.prettier-vscode", targetPlatform: "universal" },
          }),
        },
      } as never)

      const updates = await updater.checkForUpdates()

      // The extension id never reaches the cognia registry...
      const cogniaIds = cogniaGetPlugin.mock.calls.map((c) => c[0])
      expect(cogniaIds).not.toContain("esbenp.prettier-vscode")
      expect(cogniaIds).toEqual(["plugin-a"])
      // ...and it does reach Open VSX instead.
      expect(queryExtension).toHaveBeenCalledTimes(1)
      expect(queryExtension.mock.calls[0][0]).toMatchObject({
        extensionId: "esbenp.prettier-vscode",
      })
      // Both registries produced their update.
      expect(updates.map((u) => u.pluginId).sort()).toEqual(["esbenp.prettier-vscode", "plugin-a"])
    })

    it("re-queries with the recorded targetPlatform, not the current machine's", async () => {
      // A `universal` fallback install must keep being checked as `universal`.
      // Deriving the platform from the asking machine would offer a
      // platform-specific build as an "update" for a universal install.
      const queryExtension = fakeOpenVsxClient()
      mockGetStoreState.mockReturnValue({
        plugins: {
          "rust-lang.rust-analyzer": storePlugin({
            id: "rust-lang.rust-analyzer",
            version: "1.0.0",
            type: "vscode-extension",
            vscodeExtension: { targetPlatform: "universal" },
          }),
        },
      } as never)

      await updater.checkForUpdates()

      expect(queryExtension.mock.calls[0][0]).toMatchObject({ targetPlatform: "universal" })
    })

    it("update_check_respects_cache_ttl", async () => {
      // getCached() is TTL-aware: it returns undefined for a row past 24h, so
      // a fresh hit must short-circuit the network entirely...
      const queryExtension = fakeOpenVsxClient()
      mockGetStoreState.mockReturnValue({
        plugins: {
          "esbenp.prettier-vscode": storePlugin({
            id: "esbenp.prettier-vscode",
            version: "1.0.0",
            type: "vscode-extension",
          }),
        },
      } as never)
      getCachedMock.mockResolvedValue({
        extensionId: "esbenp.prettier-vscode",
        latestVersion: "3.0.0",
        fetchedAt: Date.now(),
      })

      const fromCache = await updater.checkForUpdates()

      expect(getCachedMock).toHaveBeenCalledWith("esbenp.prettier-vscode")
      expect(queryExtension).not.toHaveBeenCalled()
      expect(fromCache[0]).toMatchObject({ latestVersion: "3.0.0" })

      // ...and a stale row (which getCached reports as absent) must fall
      // through to a real query, and re-populate the cache.
      updater.clearPendingUpdate("esbenp.prettier-vscode")
      getCachedMock.mockResolvedValue(undefined)

      const fromNetwork = await updater.checkForUpdates()

      expect(queryExtension).toHaveBeenCalledTimes(1)
      expect(putCachedMock).toHaveBeenCalled()
      expect(fromNetwork[0]).toMatchObject({ latestVersion: "2.0.0" })
    })

    it("update_check_bounds_concurrency", async () => {
      // The old loop was serial and unbounded (N+1). Bounded at 4: never more
      // than 4 lookups in flight, and never serialised down to 1 either.
      let inFlight = 0
      let peak = 0
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const queryExtension = jest.fn(async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await gate
        inFlight--
        return {
          offset: 0,
          totalSize: 1,
          extensions: [{ namespace: "ns", name: "ext", version: "2.0.0", files: {} }],
        }
      })
      getOpenVsxClientMock.mockReturnValue({ queryExtension })

      const plugins: Record<string, unknown> = {}
      for (let i = 0; i < 12; i++) {
        plugins[`ns.ext-${i}`] = storePlugin({
          id: `ns.ext-${i}`,
          version: "1.0.0",
          type: "vscode-extension",
        })
      }
      mockGetStoreState.mockReturnValue({ plugins } as never)

      const pending = updater.checkForUpdates()

      // Wait on the condition, not on a guessed number of microtask ticks —
      // checkOpenVsxUpdates dynamic-imports the client first, so tick counting
      // is a race. Settle once the first wave has parked on the gate.
      const tick = () => new Promise((r) => setTimeout(r, 0))
      for (let i = 0; i < 100 && inFlight === 0; i++) await tick()
      for (let i = 0; i < 20; i++) await tick()

      // 12 extensions, limit 4, every worker blocked: exactly 4 in flight.
      // Not "<= 4" — that would also pass if the loop had gone back to serial.
      expect(peak).toBe(4)
      expect(queryExtension).toHaveBeenCalledTimes(4)

      release()
      await pending
      expect(queryExtension).toHaveBeenCalledTimes(12)
      expect(peak).toBe(4)
    })

    it("one failing extension does not sink the rest of the check", async () => {
      const queryExtension = jest.fn(async (opts: { extensionId: string }) => {
        if (opts.extensionId === "ns.broken") throw new Error("registry down")
        return {
          offset: 0,
          totalSize: 1,
          extensions: [{ namespace: "ns", name: "ok", version: "2.0.0", files: {} }],
        }
      })
      getOpenVsxClientMock.mockReturnValue({ queryExtension })
      mockGetStoreState.mockReturnValue({
        plugins: {
          "ns.broken": storePlugin({ id: "ns.broken", version: "1.0.0", type: "vscode-extension" }),
          "ns.ok": storePlugin({ id: "ns.ok", version: "1.0.0", type: "vscode-extension" }),
        },
      } as never)

      const updates = await updater.checkForUpdates()

      expect(updates.map((u) => u.pluginId)).toEqual(["ns.ok"])
    })

    it("never offers a pre-release as an update", async () => {
      // Open VSX's "latest" means newest *published* — rust-analyzer's latest
      // is literally a pre-release. Selection reads `preRelease`, not the alias.
      const queryExtension = jest.fn(async () => ({
        offset: 0,
        totalSize: 2,
        extensions: [
          {
            namespace: "rust-lang",
            name: "rust-analyzer",
            version: "3.0.0",
            preRelease: true,
            versionAlias: ["latest", "pre-release"],
            files: {},
          },
          { namespace: "rust-lang", name: "rust-analyzer", version: "2.0.0", files: {} },
        ],
      }))
      getOpenVsxClientMock.mockReturnValue({ queryExtension })
      mockGetStoreState.mockReturnValue({
        plugins: {
          "rust-lang.rust-analyzer": storePlugin({
            id: "rust-lang.rust-analyzer",
            version: "1.0.0",
            type: "vscode-extension",
          }),
        },
      } as never)

      const updates = await updater.checkForUpdates()

      expect(updates[0].latestVersion).toBe("2.0.0")
    })

    it("skips the Open VSX modules entirely when no extension is installed", async () => {
      // The client/cache are desktop-install concerns; a user with no
      // extensions should never load them.
      getOpenVsxClientMock.mockReturnValue({ queryExtension: jest.fn() })
      await updater.checkForUpdates()
      expect(getOpenVsxClientMock).not.toHaveBeenCalled()
    })

    it("refuses to headlessly update a VS Code extension", async () => {
      // A new version may request new permissions and update() has no consent
      // callbacks — so this refuses rather than silently installing, and
      // rather than falling through to the cognia registry.
      mockGetStoreState.mockReturnValue({
        plugins: {
          "esbenp.prettier-vscode": storePlugin({
            id: "esbenp.prettier-vscode",
            version: "1.0.0",
            type: "vscode-extension",
          }),
        },
      } as never)

      const result = await updater.update("esbenp.prettier-vscode", {
        force: true,
        version: "2.0.0",
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("VS Code extension")
      expect(cogniaGetPlugin).not.toHaveBeenCalled()
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
