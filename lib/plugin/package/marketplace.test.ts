/**
 * PluginMarketplace Tests
 */

import {
  LocalPluginSource,
  PluginMarketplace,
  getPluginMarketplace,
  resetPluginMarketplace,
  usePluginMarketplace,
} from "./marketplace"

// Mock fetch
global.fetch = jest.fn()
const mockFetch = global.fetch as jest.Mock

// Mock proxyFetch to delegate to global.fetch
jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) =>
    (global.fetch as jest.MockedFunction<typeof fetch>)(...(args as Parameters<typeof fetch>)),
}))

jest.mock("@/lib/native/utils", () => ({
  isTauri: jest.fn(() => false),
}))

jest.mock("@tauri-apps/plugin-fs", () => ({
  exists: jest.fn(),
  readDir: jest.fn(),
  readTextFile: jest.fn(),
}))

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("../security/signature", () => ({
  getPluginSignatureVerifier: jest.fn(),
}))

jest.mock("../contracts/diagnostics-store", () => ({
  recordSilentFailure: jest.fn(),
}))

const { isTauri } = jest.requireMock("@/lib/native/utils") as {
  isTauri: jest.Mock
}
const { exists, readDir, readTextFile } = jest.requireMock("@tauri-apps/plugin-fs") as {
  exists: jest.Mock
  readDir: jest.Mock
  readTextFile: jest.Mock
}
const { invoke: mockInvoke } = jest.requireMock("@tauri-apps/api/core") as {
  invoke: jest.Mock
}
const { getPluginSignatureVerifier: mockGetSignatureVerifier } = jest.requireMock(
  "../security/signature"
) as {
  getPluginSignatureVerifier: jest.Mock
}
const { recordSilentFailure: mockRecordSilentFailure } = jest.requireMock(
  "../contracts/diagnostics-store"
) as {
  recordSilentFailure: jest.Mock
}

describe("PluginMarketplace", () => {
  let marketplace: PluginMarketplace

  beforeEach(() => {
    resetPluginMarketplace()
    marketplace = new PluginMarketplace()
    jest.clearAllMocks()
    isTauri.mockReturnValue(false)
    exists.mockResolvedValue(false)
    readDir.mockResolvedValue([])
    readTextFile.mockResolvedValue("")
  })

  describe("LocalPluginSource", () => {
    it("scans a local plugin directory and returns normalized registry entries", async () => {
      isTauri.mockReturnValue(true)
      exists.mockResolvedValue(true)
      readDir.mockResolvedValue([{ name: "local-one", isDirectory: true, isFile: false }])
      readTextFile.mockResolvedValue(
        JSON.stringify({
          id: "local-one",
          name: "Local One",
          version: "1.2.0",
          description: "Local plugin",
          type: "frontend",
          capabilities: ["tools"],
          main: "index.ts",
          author: { name: "Local Author" },
        })
      )

      const source = new LocalPluginSource()
      const results = await source.scan("D:/Plugins")

      expect(results).toHaveLength(1)
      expect(results[0]).toEqual(
        expect.objectContaining({
          id: "local-one",
          name: "Local One",
          version: "1.2.0",
          latestVersion: "1.2.0",
          source: "local",
        })
      )
      expect(results[0].descriptor?.resolvedPath).toContain("local-one")
      expect(readTextFile).toHaveBeenCalledWith("D:/Plugins/local-one/plugin.json")
    })

    it("resolves plugin-relative icon assets for local plugin entries", async () => {
      isTauri.mockReturnValue(true)
      exists.mockImplementation(
        async (path: string) =>
          path !== "D:/Plugins/local-one/manifest.json" &&
          path !== "D:/Plugins/local-one/package.json"
      )
      readDir.mockResolvedValue([{ name: "local-one", isDirectory: true, isFile: false }])
      readTextFile.mockResolvedValue(
        JSON.stringify({
          id: "local-one",
          name: "Local One",
          version: "1.2.0",
          description: "Local plugin",
          type: "frontend",
          capabilities: ["tools"],
          icon: "assets/icon.svg",
          main: "index.ts",
          author: { name: "Local Author" },
        })
      )

      const source = new LocalPluginSource()
      const results = await source.scan("D:/Plugins")

      expect(results[0].icon).toBe("assets/icon.svg")
      expect(results[0].resolvedIcon).toEqual(
        expect.objectContaining({
          kind: "image",
          transport: "file",
          src: "D:/Plugins/local-one/assets/icon.svg",
        })
      )
    })

    it("skips invalid local manifests without failing the full scan", async () => {
      isTauri.mockReturnValue(true)
      exists.mockResolvedValue(true)
      readDir.mockResolvedValue([{ name: "bad-plugin", isDirectory: true, isFile: false }])
      readTextFile.mockResolvedValue("{ invalid json")

      const source = new LocalPluginSource()
      const results = await source.scan("D:/Plugins")

      expect(results).toEqual([])
    })
  })

  describe("Plugin Search", () => {
    it("should search plugins by query", async () => {
      const mockResults = {
        plugins: [{ id: "chat-plugin", name: "Chat Enhancement", version: "1.0.0" }],
        total: 1,
        hasMore: false,
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResults),
      })

      const result = await marketplace.searchPlugins({ query: "chat" })

      expect(mockFetch).toHaveBeenCalled()
      expect(result.plugins).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it("should search with category filter", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ plugins: [], total: 0, hasMore: false }),
      })

      await marketplace.searchPlugins({
        query: "test",
        category: "productivity",
      })

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain("category=productivity")
    })

    it("should handle search errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"))

      const consoleSpy = jest.spyOn(console, "error").mockImplementation()
      const result = await marketplace.searchPlugins({ query: "test" })

      expect(result.plugins).toEqual([])
      expect(result.total).toBe(0)

      consoleSpy.mockRestore()
    })
  })

  describe("Featured Plugins", () => {
    it("should fetch featured plugins", async () => {
      const mockPlugins = {
        plugins: [
          { id: "plugin-1", name: "Plugin 1", version: "1.0.0" },
          { id: "plugin-2", name: "Plugin 2", version: "2.0.0" },
        ],
        total: 2,
        hasMore: false,
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockPlugins),
      })

      const result = await marketplace.getFeaturedPlugins()

      expect(mockFetch).toHaveBeenCalled()
      expect(result).toHaveLength(2)
    })
  })

  describe("Plugin Details", () => {
    it("should fetch plugin details", async () => {
      const mockPlugin = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        description: "A test plugin",
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockPlugin),
      })

      const result = await marketplace.getPlugin("test-plugin")

      expect(result).toBeDefined()
      expect(result?.id).toBe("test-plugin")
    })

    it("should return null for non-existent plugin", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      const result = await marketplace.getPlugin("non-existent")

      expect(result).toBeNull()
    })
  })

  describe("Version Management", () => {
    it("should fetch available versions", async () => {
      const mockVersions = [
        { version: "1.0.0", publishedAt: new Date(), downloadUrl: "url1" },
        { version: "1.1.0", publishedAt: new Date(), downloadUrl: "url2" },
      ]

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockVersions),
      })

      const result = await marketplace.getVersions("test-plugin")

      expect(result).toHaveLength(2)
      expect(result[0].version).toBe("1.0.0")
    })

    it("should return empty array on error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"))

      const consoleSpy = jest.spyOn(console, "error").mockImplementation()
      const result = await marketplace.getVersions("test-plugin")

      expect(result).toEqual([])

      consoleSpy.mockRestore()
    })
  })

  describe("Categories", () => {
    it("should fetch categories", async () => {
      const mockCategories = [
        { id: "productivity", name: "Productivity", count: 10 },
        { id: "ai", name: "AI", count: 5 },
      ]

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCategories),
      })

      const result = await marketplace.getCategories()

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe("productivity")
    })
  })

  describe("Dependency Resolution", () => {
    it("should resolve plugin dependencies", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "main-plugin",
            manifest: { dependencies: {} },
          }),
      })

      const result = await marketplace.resolveDependencies("main-plugin")

      expect(result.resolved).toBeDefined()
      expect(result.missing).toBeDefined()
    })

    it("should report missing plugin", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      const result = await marketplace.resolveDependencies("non-existent")

      expect(result.resolved).toBe(false)
      expect(result.missing).toContain("non-existent")
    })
  })

  describe("Installation", () => {
    it("should install plugin with progress callback", async () => {
      const progressUpdates: string[] = []

      // Setup progress listener
      marketplace.onInstallProgress("test-plugin", (progress) => {
        progressUpdates.push(progress.stage)
      })

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "test-plugin", manifest: {} }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{ version: "1.0.0", downloadUrl: "url" }]),
        })

      const result = await marketplace.installPlugin("test-plugin")

      expect(result.success).toBe(false)
      expect(result.errorCategory).toBe("unsupported_env")
      expect(progressUpdates).toContain("error")
    })

    it("should emit error progress events in web environment", async () => {
      const stages: string[] = []

      marketplace.onInstallProgress("web-plugin", (progress) => {
        stages.push(progress.stage)
      })

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "web-plugin", name: "Web Plugin", manifest: {} }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{ version: "1.0.0", downloadUrl: "url" }]),
        })

      await marketplace.installPlugin("web-plugin")

      // Web environment: install/update is blocked without desktop runtime.
      expect(stages).toContain("error")
      expect(stages).not.toContain("complete")
    })

    describe("Signature verification (ADR 0016 P0-3)", () => {
      const goodPluginPayload = {
        id: "trusted-plugin",
        name: "Trusted Plugin",
        manifest: {
          id: "trusted-plugin",
          name: "Trusted Plugin",
          version: "1.0.0",
          type: "frontend",
          capabilities: [],
          main: "index.js",
          author: { name: "Test" },
        },
      }

      const seedDesktopFetches = () => {
        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve(goodPluginPayload),
          })
          // getVersions in desktop mode falls back to fetch only when invoke
          // rejects, but the install path also calls getVersions through fetch
          // first via `plugin.manifest`. Stub the versions endpoint just in
          // case the implementation walks fetch.
          .mockResolvedValue({
            ok: true,
            json: () => Promise.resolve([{ version: "1.0.0", downloadUrl: "url" }]),
          })
      }

      beforeEach(() => {
        isTauri.mockReturnValue(true)
        mockInvoke.mockImplementation(async (cmd: string) => {
          if (cmd === "plugin_marketplace_versions") {
            return [{ version: "1.0.0", downloadUrl: "url" }]
          }
          if (cmd === "plugin_get_directory") {
            return "/plugins"
          }
          if (cmd === "plugin_download_version") {
            return { success: true, pluginId: "trusted-plugin", version: "1.0.0" }
          }
          if (cmd === "plugin_install") {
            return undefined
          }
          throw new Error(`unexpected invoke: ${cmd}`)
        })
      })

      it("(a) valid signature + toggle on → install succeeds", async () => {
        seedDesktopFetches()
        const verify = jest.fn().mockResolvedValue({
          valid: true,
          pluginId: "trusted-plugin",
          version: "1.0.0",
          warnings: [],
        })
        mockGetSignatureVerifier.mockReturnValue({
          verify,
          getConfig: () => ({ requireSignatures: false }),
        })

        const result = await marketplace.installPlugin("trusted-plugin", "1.0.0")

        if (!result.success) console.warn("install failed:", result.error)
        expect(verify).toHaveBeenCalledWith("/plugins/trusted-plugin")
        expect(result.success).toBe(true)
        expect(mockRecordSilentFailure).not.toHaveBeenCalled()
      })

      it("(b) invalid signature + toggle on → install rejects with signature_invalid", async () => {
        seedDesktopFetches()
        const verify = jest.fn().mockResolvedValue({
          valid: false,
          pluginId: "trusted-plugin",
          version: "1.0.0",
          reason: "Cryptographic verification failed",
          warnings: [],
        })
        mockGetSignatureVerifier.mockReturnValue({
          verify,
          getConfig: () => ({ requireSignatures: false }),
        })

        const result = await marketplace.installPlugin("trusted-plugin", "1.0.0")

        expect(result.success).toBe(false)
        expect(result.errorCategory).toBe("signature_invalid")
        expect(result.retryable).toBe(false)
        expect(result.error).toContain("Cryptographic verification failed")
      })

      it("(c) valid + warnings (signature toggle off / unsigned bundle) → install proceeds + records bypass", async () => {
        seedDesktopFetches()
        const verify = jest.fn().mockResolvedValue({
          valid: true,
          pluginId: "trusted-plugin",
          version: "1.0.0",
          warnings: ["Plugin is not signed"],
        })
        mockGetSignatureVerifier.mockReturnValue({
          verify,
          getConfig: () => ({ requireSignatures: false }),
        })

        const result = await marketplace.installPlugin("trusted-plugin", "1.0.0")

        expect(result.success).toBe(true)
        expect(mockRecordSilentFailure).toHaveBeenCalledWith(
          "trusted-plugin",
          expect.objectContaining({
            site: "marketplace.signatureBypass",
            expected: false,
          }),
          expect.any(Error)
        )
      })

      it("(d) forwards the signature policy + integrity claims to the host download", async () => {
        seedDesktopFetches()
        const verify = jest.fn().mockResolvedValue({
          valid: true,
          pluginId: "trusted-plugin",
          version: "1.0.0",
          warnings: [],
        })
        // Policy requires signatures — the host must receive requireSignature:true
        // so an unsigned archive is rejected in Rust before unpacking.
        mockGetSignatureVerifier.mockReturnValue({
          verify,
          getConfig: () => ({ requireSignatures: true }),
        })

        await marketplace.installPlugin("trusted-plugin", "1.0.0")

        const downloadCall = mockInvoke.mock.calls.find(
          ([cmd]) => cmd === "plugin_download_version"
        )
        expect(downloadCall).toBeDefined()
        expect(downloadCall?.[1]).toEqual(
          expect.objectContaining({
            pluginId: "trusted-plugin",
            version: "1.0.0",
            requireSignature: true,
          })
        )
      })
    })
  })

  describe("Update checks", () => {
    it("reports updates when a local source has a newer version than the installed plugin", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "local-plugin",
            name: "Local Plugin",
            description: "Local plugin",
            version: "1.0.0",
            latestVersion: "1.1.0",
            downloads: 0,
            rating: 0,
            ratingCount: 0,
            tags: [],
            categories: [],
            manifest: {
              id: "local-plugin",
              name: "Local Plugin",
              version: "1.1.0",
              description: "Local plugin",
              type: "frontend",
              capabilities: ["tools"],
              main: "index.ts",
            },
            publishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            verified: false,
            featured: false,
          }),
      })

      const updates = await marketplace.checkForUpdates([{ id: "local-plugin", version: "1.0.0" }])

      expect(updates).toEqual([
        {
          id: "local-plugin",
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
        },
      ])
    })
  })

  describe("Cache", () => {
    it("should cache API responses", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "cached-plugin", name: "Cached" }),
      })

      // First call hits API
      await marketplace.getPlugin("cached-plugin")
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // Second call should use cache (no additional fetch)
      await marketplace.getPlugin("cached-plugin")
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it("should clear cache", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "cached-plugin", name: "Cached" }),
      })

      await marketplace.getPlugin("cached-plugin")
      expect(mockFetch).toHaveBeenCalledTimes(1)

      marketplace.clearCache()

      await marketplace.getPlugin("cached-plugin")
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it("negative-caches getPlugin network failures so repeated checks don't re-fetch", async () => {
      mockFetch.mockRejectedValue(new Error("Failed to fetch"))

      expect(await marketplace.getPlugin("offline-plugin")).toBeNull()
      expect(mockFetch).toHaveBeenCalledTimes(1)

      // A second lookup within the negative-cache window short-circuits — this
      // is what stops "Check for updates" from re-hitting the registry (and
      // re-logging) once per installed plugin, every check.
      expect(await marketplace.getPlugin("offline-plugin")).toBeNull()
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it("negative-caches getPlugin 404s", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 })

      expect(await marketplace.getPlugin("missing")).toBeNull()
      expect(await marketplace.getPlugin("missing")).toBeNull()
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it("re-fetches a previously-failed getPlugin after clearCache", async () => {
      mockFetch.mockRejectedValue(new Error("Failed to fetch"))

      await marketplace.getPlugin("offline-plugin")
      expect(mockFetch).toHaveBeenCalledTimes(1)

      marketplace.clearCache()

      await marketplace.getPlugin("offline-plugin")
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })

  describe("Popular and Recent Plugins", () => {
    it("should fetch popular plugins", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ plugins: [{ id: "popular" }], total: 1, hasMore: false }),
      })

      const result = await marketplace.getPopularPlugins(5)

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain("sort=downloads")
      expect(result).toHaveLength(1)
    })

    it("should fetch recent plugins", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ plugins: [{ id: "recent" }], total: 1, hasMore: false }),
      })

      const result = await marketplace.getRecentPlugins(5)

      const calledUrl = mockFetch.mock.calls[0][0] as string
      expect(calledUrl).toContain("sort=updated")
      expect(result).toHaveLength(1)
    })
  })

  describe("Singleton", () => {
    it("should return the same instance", () => {
      const instance1 = getPluginMarketplace()
      const instance2 = getPluginMarketplace()

      expect(instance1).toBe(instance2)
    })

    it("should reset singleton on reset call", () => {
      const instance1 = getPluginMarketplace()
      resetPluginMarketplace()
      const instance2 = getPluginMarketplace()

      expect(instance1).not.toBe(instance2)
    })

    it("should provide hook for accessing marketplace", () => {
      const result = usePluginMarketplace()
      expect(result).toBeInstanceOf(PluginMarketplace)
    })
  })
})
