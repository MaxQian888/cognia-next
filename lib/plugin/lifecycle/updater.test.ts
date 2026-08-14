/**
 * Tests for Plugin Updater
 */

import { PluginUpdater, getPluginUpdater, resetPluginUpdater } from "./updater"

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: jest.fn(),
    setState: jest.fn(),
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
  const installPlugin = jest.fn().mockResolvedValue({ success: true })
  const stagePluginUpdate = jest.fn().mockResolvedValue({
    transactionId: "123e4567-e89b-42d3-a456-426614174000",
    pluginId: "plugin-a",
    version: "2.0.0",
    stagedPath: "/host-state/update-transactions/plugin-a/package",
    manifest: {
      id: "plugin-a",
      name: "Plugin A",
      version: "2.0.0",
      description: "Plugin A",
      type: "frontend",
      capabilities: [],
      main: "index.js",
    },
    sizeBytes: 1024,
  })
  const commitStagedPluginUpdate = jest.fn().mockResolvedValue(undefined)
  const discardStagedPluginUpdate = jest.fn().mockResolvedValue(undefined)
  const finalizeStagedPluginUpdate = jest.fn().mockResolvedValue(undefined)
  return {
    __getPluginSpy: getPlugin,
    __installPluginSpy: installPlugin,
    __stagePluginUpdateSpy: stagePluginUpdate,
    __commitStagedPluginUpdateSpy: commitStagedPluginUpdate,
    __discardStagedPluginUpdateSpy: discardStagedPluginUpdate,
    __finalizeStagedPluginUpdateSpy: finalizeStagedPluginUpdate,
    getPluginMarketplace: () => ({
      getPlugin,
      getVersions: jest.fn().mockResolvedValue([
        {
          version: "2.0.0",
          publishedAt: new Date(),
          downloadUrl: "https://example.com/plugin-a-2.0.0.zip",
        },
      ]),
      installPlugin,
      stagePluginUpdate,
      commitStagedPluginUpdate,
      discardStagedPluginUpdate,
      finalizeStagedPluginUpdate,
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
  __createBackupSpy: jest.fn().mockResolvedValue({
    success: true,
    backup: { id: "plugin-a-before-update", pluginId: "plugin-a", version: "1.0.0" },
  }),
  __restoreBackupSpy: jest.fn().mockResolvedValue({ success: true }),
  getPluginBackupManager() {
    const mockedBackup = jest.requireMock("./backup") as {
      __createBackupSpy: jest.Mock
      __restoreBackupSpy: jest.Mock
    }
    return {
      createBackup: mockedBackup.__createBackupSpy,
      restore: mockedBackup.__restoreBackupSpy,
    }
  },
}))

jest.mock("../core/manager", () => ({
  __disablePluginSpy: jest.fn().mockResolvedValue(undefined),
  __unloadPluginSpy: jest.fn().mockResolvedValue(undefined),
  __scanPluginsSpy: jest.fn().mockResolvedValue([]),
  __syncRuntimeStateSpy: jest.fn().mockResolvedValue(undefined),
  __enablePluginSpy: jest.fn().mockResolvedValue(undefined),
  __reservePluginRuntimeGraphSpy: jest.fn(() => ({
    managerId: "manager",
    pluginId: "plugin-a",
    token: 1,
  })),
  __releasePluginRuntimeGraphSpy: jest.fn(() => true),
  getPluginManager() {
    const mockedManager = jest.requireMock("../core/manager") as Record<string, jest.Mock>
    return {
      disablePlugin: mockedManager.__disablePluginSpy,
      unloadPlugin: mockedManager.__unloadPluginSpy,
      scanPlugins: mockedManager.__scanPluginsSpy,
      syncRuntimeState: mockedManager.__syncRuntimeStateSpy,
      enablePlugin: mockedManager.__enablePluginSpy,
      reservePluginRuntimeGraph: mockedManager.__reservePluginRuntimeGraphSpy,
      releasePluginRuntimeGraph: mockedManager.__releasePluginRuntimeGraphSpy,
    }
  },
}))

jest.mock("../ide/proxy-manager", () => ({
  __stageManagedIdeProxySpy: jest.fn().mockResolvedValue(null),
  stageManagedIdeProxy(plugin: unknown) {
    const mocked = jest.requireMock("../ide/proxy-manager") as {
      __stageManagedIdeProxySpy: jest.Mock
    }
    return mocked.__stageManagedIdeProxySpy(plugin)
  },
}))

jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    activateProxy: jest.fn().mockResolvedValue(true),
  },
}))

import { usePluginStore } from "@/stores/plugin-runtime"
import { codeServerClient } from "@/lib/codeserver/client"
import { getOpenVsxClient } from "@/lib/plugin/vscode-shim/openvsx-client"
import { getCached, putCached } from "@/lib/plugin/vscode-shim/openvsx-cache"

const marketplaceModule = jest.requireMock("../package/marketplace") as {
  __getPluginSpy: jest.Mock
  __installPluginSpy: jest.Mock
  __stagePluginUpdateSpy: jest.Mock
  __commitStagedPluginUpdateSpy: jest.Mock
  __discardStagedPluginUpdateSpy: jest.Mock
  __finalizeStagedPluginUpdateSpy: jest.Mock
}
const cogniaGetPlugin = marketplaceModule.__getPluginSpy
const cogniaInstallPlugin = marketplaceModule.__installPluginSpy
const stagePluginUpdate = marketplaceModule.__stagePluginUpdateSpy
const commitStagedPluginUpdate = marketplaceModule.__commitStagedPluginUpdateSpy
const discardStagedPluginUpdate = marketplaceModule.__discardStagedPluginUpdateSpy
const finalizeStagedPluginUpdate = marketplaceModule.__finalizeStagedPluginUpdateSpy
const proxyManagerModule = jest.requireMock("../ide/proxy-manager") as {
  __stageManagedIdeProxySpy: jest.Mock
}
const backupModule = jest.requireMock("./backup") as {
  __createBackupSpy: jest.Mock
  __restoreBackupSpy: jest.Mock
}
const managerModule = jest.requireMock("../core/manager") as {
  __disablePluginSpy: jest.Mock
  __unloadPluginSpy: jest.Mock
  __scanPluginsSpy: jest.Mock
  __syncRuntimeStateSpy: jest.Mock
  __enablePluginSpy: jest.Mock
  __reservePluginRuntimeGraphSpy: jest.Mock
  __releasePluginRuntimeGraphSpy: jest.Mock
}
const getOpenVsxClientMock = getOpenVsxClient as jest.Mock
const getCachedMock = getCached as jest.Mock
const putCachedMock = putCached as jest.Mock

const mockGetStoreState = usePluginStore.getState as jest.MockedFunction<
  typeof usePluginStore.getState
>
const mockSetStoreState = usePluginStore.setState as jest.Mock

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
    const runtimeState = {
      plugins: {
        "plugin-a": {
          manifest: { id: "plugin-a", version: "1.0.0" },
          status: "installed",
        },
      },
    }
    mockGetStoreState.mockImplementation(() => runtimeState as never)
    mockSetStoreState.mockImplementation((updater) => {
      const patch = typeof updater === "function" ? updater(runtimeState) : updater
      if (patch && typeof patch === "object") Object.assign(runtimeState, patch)
    })
    backupModule.__createBackupSpy.mockResolvedValue({
      success: true,
      backup: {
        id: "plugin-a-before-update",
        pluginId: "plugin-a",
        version: "1.0.0",
      },
    })
    backupModule.__restoreBackupSpy.mockReset().mockResolvedValue({ success: true })
    managerModule.__enablePluginSpy.mockReset().mockResolvedValue(undefined)
    managerModule.__reservePluginRuntimeGraphSpy.mockImplementation(() => ({
      managerId: "manager",
      pluginId: "plugin-a",
      token: 1,
    }))
    managerModule.__releasePluginRuntimeGraphSpy.mockReturnValue(true)
    cogniaInstallPlugin.mockResolvedValue({ success: true })
    stagePluginUpdate.mockResolvedValue({
      transactionId: "123e4567-e89b-42d3-a456-426614174000",
      pluginId: "plugin-a",
      version: "2.0.0",
      stagedPath: "/host-state/update-transactions/plugin-a/package",
      manifest: {
        id: "plugin-a",
        name: "Plugin A",
        version: "2.0.0",
        description: "Plugin A",
        type: "frontend",
        capabilities: [],
        main: "index.js",
      },
      sizeBytes: 1024,
    })
    commitStagedPluginUpdate.mockResolvedValue(undefined)
    discardStagedPluginUpdate.mockResolvedValue(undefined)
    finalizeStagedPluginUpdate.mockResolvedValue(undefined)
    proxyManagerModule.__stageManagedIdeProxySpy.mockResolvedValue(null)
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

    it("unloads an active plugin before commit and re-enables it after verification", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: { version: string }; status: string }>
      }
      state.plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "2.0.0"
        return { success: true }
      })

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result.success).toBe(true)
      expect(managerModule.__disablePluginSpy).toHaveBeenCalledWith(
        "plugin-a",
        "transactional-update"
      )
      expect(managerModule.__unloadPluginSpy).toHaveBeenCalledWith("plugin-a")
      expect(managerModule.__enablePluginSpy).toHaveBeenCalledWith("plugin-a")
      expect(managerModule.__reservePluginRuntimeGraphSpy).toHaveBeenCalledWith("plugin-a")
      expect(managerModule.__releasePluginRuntimeGraphSpy).toHaveBeenCalledTimes(1)
      expect(managerModule.__unloadPluginSpy.mock.invocationCallOrder[0]).toBeLessThan(
        commitStagedPluginUpdate.mock.invocationCallOrder[0]
      )
      expect(stagePluginUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        backupModule.__createBackupSpy.mock.invocationCallOrder[0]
      )
      expect(proxyManagerModule.__stageManagedIdeProxySpy.mock.invocationCallOrder[0]).toBeLessThan(
        backupModule.__createBackupSpy.mock.invocationCallOrder[0]
      )
      expect(finalizeStagedPluginUpdate).toHaveBeenCalledTimes(1)
    })

    it("requires permission review before snapshot or commit when an update expands authority", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: Record<string, unknown>; status: string }>
      }
      state.plugins["plugin-a"].manifest.permissions = ["storage:read"]
      stagePluginUpdate.mockResolvedValueOnce({
        transactionId: "123e4567-e89b-42d3-a456-426614174000",
        pluginId: "plugin-a",
        version: "2.0.0",
        stagedPath: "/host-state/update-transactions/plugin-a/package",
        manifest: {
          id: "plugin-a",
          name: "Plugin A",
          version: "2.0.0",
          description: "Plugin A",
          type: "frontend",
          capabilities: [],
          main: "index.js",
          permissions: ["storage:read", "shell:execute"],
        },
        sizeBytes: 1024,
      })

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("PLUGIN_UPDATE_PERMISSION_REVIEW_REQUIRED"),
      })
      expect(discardStagedPluginUpdate).toHaveBeenCalledTimes(1)
      expect(backupModule.__createBackupSpy).not.toHaveBeenCalled()
      expect(commitStagedPluginUpdate).not.toHaveBeenCalled()
    })

    it("dry-runs the migration declaration before snapshotting a destructive schema change", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: Record<string, unknown>; status: string }>
      }
      state.plugins["plugin-a"].manifest.dexie = {
        tables: [{ name: "records", schema: "++id, createdAt" }],
      }
      stagePluginUpdate.mockResolvedValueOnce({
        transactionId: "123e4567-e89b-42d3-a456-426614174000",
        pluginId: "plugin-a",
        version: "2.0.0",
        stagedPath: "/host-state/update-transactions/plugin-a/package",
        manifest: {
          id: "plugin-a",
          name: "Plugin A",
          version: "2.0.0",
          description: "Plugin A",
          type: "frontend",
          capabilities: [],
          main: "index.js",
          dexie: {
            tables: [{ name: "records", schema: "++id, &externalId" }],
          },
        },
        sizeBytes: 1024,
      })

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result.error).toContain("PLUGIN_UPDATE_MIGRATION_REQUIRED")
      expect(discardStagedPluginUpdate).toHaveBeenCalledTimes(1)
      expect(backupModule.__createBackupSpy).not.toHaveBeenCalled()
    })

    it("activates the exact staged proxy after package commit", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: { version: string }; status: string }>
      }
      state.plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "2.0.0"
      })
      const artifact = { pluginId: "plugin-a", sha256: "proxy-v2" }
      proxyManagerModule.__stageManagedIdeProxySpy.mockResolvedValueOnce(artifact)

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result.success).toBe(true)
      expect(codeServerClient.activateProxy).toHaveBeenCalledWith(artifact)
      expect(commitStagedPluginUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        (codeServerClient.activateProxy as jest.Mock).mock.invocationCallOrder[0]
      )
    })

    it("restores package and host state when live activation rejects the update", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: { version: string }; status: string }>
      }
      state.plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "2.0.0"
        return { success: true }
      })
      backupModule.__restoreBackupSpy.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "1.0.0"
        return { success: true }
      })
      managerModule.__enablePluginSpy.mockRejectedValueOnce(new Error("proxy handshake failed"))

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result).toMatchObject({
        success: false,
        rollback: { attempted: true, succeeded: true },
        requiresRestart: true,
      })
      expect(backupModule.__restoreBackupSpy).toHaveBeenCalledWith("plugin-a-before-update")
      expect(managerModule.__enablePluginSpy).toHaveBeenCalledTimes(1)
      expect(state.plugins["plugin-a"].manifest.version).toBe("1.0.0")
    })

    it("does not request a restart when the old package could not be restored", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: { version: string }; status: string }>
      }
      state.plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "2.0.0"
        return { success: true }
      })
      managerModule.__enablePluginSpy.mockRejectedValueOnce(new Error("proxy handshake failed"))
      backupModule.__restoreBackupSpy.mockResolvedValueOnce({
        success: false,
        error: "backup checksum mismatch",
      })

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result).toMatchObject({
        success: false,
        requiresRestart: false,
        rollback: {
          attempted: true,
          succeeded: false,
          error: expect.stringContaining("backup checksum mismatch"),
        },
      })
    })

    it("keeps the restored package inactive instead of resurrecting the old runtime", async () => {
      const state = mockGetStoreState() as never as {
        plugins: Record<string, { manifest: { version: string }; status: string }>
      }
      state.plugins["plugin-a"].status = "enabled"
      commitStagedPluginUpdate.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "2.0.0"
        return { success: true }
      })
      backupModule.__restoreBackupSpy.mockImplementationOnce(async () => {
        state.plugins["plugin-a"].manifest.version = "1.0.0"
        return { success: true }
      })
      managerModule.__enablePluginSpy.mockRejectedValueOnce(new Error("new proxy rejected"))

      const result = await updater.update("plugin-a", { force: true, version: "2.0.0" })

      expect(result).toMatchObject({
        success: false,
        requiresRestart: true,
        rollback: {
          attempted: true,
          succeeded: true,
        },
      })
      expect(managerModule.__enablePluginSpy).toHaveBeenCalledTimes(1)
      expect(state.plugins["plugin-a"].manifest.version).toBe("1.0.0")
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
