/**
 * PluginManager Tests
 */

import { invoke } from "@tauri-apps/api/core"
import {
  PluginManager,
  PluginEnableError,
  PluginDependencyError,
  resolveGovernanceMode,
  createPluginManager,
  getPluginManager,
  initializePluginManager,
  __resetPluginManagerForTesting,
} from "./manager"
import {
  getPluginPointDiagnostics,
  __resetDiagnosticsStoreForTesting,
} from "@/lib/plugin/contracts/diagnostics-store"
import type { Plugin, PluginManifest } from "@/types/plugin"
import { getPluginSignatureVerifier } from "@/lib/plugin/security/signature"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import {
  createExtensionAPI,
  getPluginExtensionRegistrationCount,
  clearPluginExtensions,
} from "@/lib/plugin/api/extension-api"
import { canUseTauriInvoke } from "@/lib/native/utils"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: jest.fn(),
  },
}))

jest.mock("@/lib/plugin/security/signature", () => ({
  getPluginSignatureVerifier: jest.fn(),
}))

jest.mock("@/lib/plugin/security/permission-guard", () => ({
  getPermissionGuard: jest.fn(),
  createGuardedAPI: jest.fn((_pluginId, api) => api),
}))

jest.mock("@/lib/native/utils", () => ({
  canUseTauriInvoke: jest.fn(() => true),
  // ADR-0026 §5 §C — `createCapabilitiesAPI()` (mounted on every full
  // plugin context) reads `isTauri()` from this module. Mock it here so
  // the plugin lifecycle tests don't crash with "isTauri is not a
  // function" when instantiating the context.
  isTauri: jest.fn(() => false),
}))

jest.mock("@/lib/chat/slash-command-registry", () => ({
  getSlashCommand: jest.fn(),
  registerSlashCommand: jest.fn(),
  unregisterSlashCommand: jest.fn(),
}))

// IndexedDB isn't available in this unit-test environment; the bridge would
// throw DatabaseClosedError on `applyPluginTables` / `removePluginTables`,
// blowing up uninstallPlugin's cleanup path before the assertions run.
jest.mock("@/lib/plugin/dexie/bridge", () => ({
  applyPluginTables: jest.fn(async () => undefined),
  removePluginTables: jest.fn(async () => undefined),
}))

import { usePluginStore } from "@/stores/plugin-runtime"
import {
  getSlashCommand,
  registerSlashCommand,
  unregisterSlashCommand,
} from "@/lib/chat/slash-command-registry"

describe("PluginManager", () => {
  const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
  const mockGetState = usePluginStore.getState as unknown as jest.Mock
  const mockVerifier = {
    verify: jest.fn(),
    getConfig: jest.fn().mockReturnValue({
      requireSignatures: false,
      allowUntrusted: true,
    }),
  }
  const mockGuard = {
    registerPlugin: jest.fn(),
    unregisterPlugin: jest.fn(),
    revokeAll: jest.fn(),
    grant: jest.fn(),
    revoke: jest.fn(),
    getPluginPermissions: jest.fn(() => [] as string[]),
  }
  const mockGetSlashCommand = getSlashCommand as jest.MockedFunction<typeof getSlashCommand>
  const mockRegisterSlashCommand = registerSlashCommand as jest.MockedFunction<
    typeof registerSlashCommand
  >
  const mockUnregisterSlashCommand = unregisterSlashCommand as jest.MockedFunction<
    typeof unregisterSlashCommand
  >
  const mockCanUseTauriInvoke = canUseTauriInvoke as jest.MockedFunction<typeof canUseTauriInvoke>

  const createManifest = (id: string): PluginManifest => ({
    id,
    name: `Plugin ${id}`,
    version: "1.0.0",
    description: "Test plugin",
    type: "frontend",
    capabilities: ["tools"],
    main: "index.ts",
  })

  beforeEach(() => {
    mockInvoke.mockReset()
    mockGetState.mockReset()
    mockVerifier.verify.mockReset()
    mockVerifier.verify.mockResolvedValue({ valid: true })
    mockGuard.registerPlugin.mockReset()
    mockGuard.unregisterPlugin.mockReset()
    mockGuard.revokeAll.mockReset()
    mockGetSlashCommand.mockReset()
    mockGetSlashCommand.mockReturnValue(undefined)
    mockRegisterSlashCommand.mockReset()
    mockUnregisterSlashCommand.mockReset()
    mockCanUseTauriInvoke.mockReset()
    mockCanUseTauriInvoke.mockReturnValue(true)
    ;(getPluginSignatureVerifier as jest.Mock).mockReturnValue(mockVerifier)
    ;(getPermissionGuard as jest.Mock).mockReturnValue(mockGuard)
    clearPluginExtensions("rollback-plugin")
  })

  describe("installPlugin", () => {
    it("should call plugin_install with installType=git and write to store", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn((manifest: PluginManifest, source: string, path: string) => {
          store.plugins[manifest.id] = {
            manifest,
            status: "discovered",
            source: source as never,
            path,
            config: {},
          }
        }),
        installPlugin: jest.fn(async (pluginId: string) => {
          const p = store.plugins[pluginId]
          if (p) {
            store.plugins[pluginId] = {
              ...p,
              status: "installed",
              installedAt: new Date(),
            }
          }
        }),
      }

      mockGetState.mockReturnValue(store)

      const manifest = createManifest("git-plugin")
      mockInvoke.mockResolvedValueOnce({
        manifest,
        path: "/plugins/git-plugin",
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      const plugin = await manager.installPlugin("https://example.com/repo.git", { type: "git" })

      expect(mockInvoke).toHaveBeenCalledWith("plugin_install", {
        source: "https://example.com/repo.git",
        installType: "git",
        pluginDir: "/plugins",
      })

      expect(store.discoverPlugin).toHaveBeenCalledWith(
        manifest,
        "git",
        "/plugins/git-plugin",
        expect.objectContaining({
          descriptor: expect.objectContaining({
            source: "git",
            resolvedPath: "/plugins/git-plugin",
            installRoot: expect.objectContaining({ kind: "installed" }),
          }),
        })
      )
      expect(store.installPlugin).toHaveBeenCalledWith("git-plugin")
      expect(plugin?.manifest.id).toBe("git-plugin")
      expect(plugin?.status).toBe("installed")
      // With requireSignatures=false and allowUntrusted=true, verify is skipped
    })

    it("should call plugin_install with installType=local when omitted", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn((manifest: PluginManifest, source: string, path: string) => {
          store.plugins[manifest.id] = {
            manifest,
            status: "discovered",
            source: source as never,
            path,
            config: {},
          }
        }),
        installPlugin: jest.fn(async (pluginId: string) => {
          const p = store.plugins[pluginId]
          if (p) {
            store.plugins[pluginId] = {
              ...p,
              status: "installed",
              installedAt: new Date(),
            }
          }
        }),
      }

      mockGetState.mockReturnValue(store)

      const manifest = createManifest("local-plugin")
      mockInvoke.mockResolvedValueOnce({
        manifest,
        path: "/plugins/local-plugin",
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await manager.installPlugin("C:/some/folder")

      expect(mockInvoke).toHaveBeenCalledWith("plugin_install", {
        source: "C:/some/folder",
        installType: "local",
        pluginDir: "/plugins",
      })
      // With requireSignatures=false and allowUntrusted=true, verify is skipped
    })

    it("should throw a helpful error when invoke fails", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn(),
        installPlugin: jest.fn(async () => undefined),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockRejectedValueOnce(new Error("boom"))

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await expect(
        manager.installPlugin("https://example.com/repo.git", { type: "git" })
      ).rejects.toThrow(/Failed to install plugin/i)
    })

    it("blocks incompatible plugin in compatibility block mode", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn(),
        installPlugin: jest.fn(async () => undefined),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValueOnce({
        manifest: {
          ...createManifest("blocked-plugin"),
          engines: { cognia: ">=9.0.0" },
        },
        path: "/plugins/blocked-plugin",
      })

      const manager = new PluginManager({
        pluginDirectory: "/plugins",
        compatibilityMode: "block",
        hostVersion: "0.1.0",
      })

      await expect(manager.installPlugin("/tmp/blocked")).rejects.toThrow(
        /Incompatible plugin manifest/i
      )
      expect(store.discoverPlugin).not.toHaveBeenCalled()
    })

    it("allows incompatible plugin in compatibility warn mode", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn((manifest: PluginManifest, source: string, path: string) => {
          store.plugins[manifest.id] = {
            manifest,
            status: "discovered",
            source: source as never,
            path,
            config: {},
          }
        }),
        installPlugin: jest.fn(async (pluginId: string) => {
          const p = store.plugins[pluginId]
          if (p) {
            store.plugins[pluginId] = {
              ...p,
              status: "installed",
              installedAt: new Date(),
            }
          }
        }),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValueOnce({
        manifest: {
          ...createManifest("warn-plugin"),
          engines: { cognia: ">=9.0.0" },
        },
        path: "/plugins/warn-plugin",
      })

      const manager = new PluginManager({
        pluginDirectory: "/plugins",
        compatibilityMode: "warn",
        hostVersion: "0.1.0",
      })

      await expect(manager.installPlugin("/tmp/warn-plugin")).resolves.toBeDefined()
      expect(store.discoverPlugin).toHaveBeenCalled()
    })

    it("records a verification snapshot after successful install", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
        setPluginVerificationSnapshot: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn((manifest: PluginManifest, source: string, path: string) => {
          store.plugins[manifest.id] = {
            manifest,
            status: "discovered",
            source: source as never,
            path,
            config: {},
          }
        }),
        installPlugin: jest.fn(async (pluginId: string) => {
          const p = store.plugins[pluginId]
          if (p) {
            store.plugins[pluginId] = {
              ...p,
              status: "installed",
              installedAt: new Date(),
            }
          }
        }),
        setPluginVerificationSnapshot: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValueOnce({
        manifest: createManifest("verified-install"),
        path: "/plugins/verified-install",
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await manager.installPlugin("/tmp/verified-install")

      expect(store.setPluginVerificationSnapshot).toHaveBeenCalledWith(
        "verified-install",
        expect.objectContaining({
          status: "installed",
          verificationStage: "installation",
          lastVerifiedAction: "install",
          lastSuccessfulAt: expect.any(String),
        })
      )
    })

    it("installWasmPluginFromLocalFile preloads the component and clears grant on uninstall", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
        uninstallPlugin: jest.Mock
        unloadPlugin: jest.Mock
        setPluginError: jest.Mock
        setPluginStatus: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn((manifest: PluginManifest, source: string, path: string) => {
          store.plugins[manifest.id] = {
            manifest,
            status: "discovered",
            source: source as never,
            path,
            config: {},
          }
        }),
        installPlugin: jest.fn(async (pluginId: string) => {
          const p = store.plugins[pluginId]
          if (p) {
            store.plugins[pluginId] = {
              ...p,
              status: "installed",
              installedAt: new Date(),
            }
          }
        }),
        uninstallPlugin: jest.fn(async (pluginId: string) => {
          delete store.plugins[pluginId]
        }),
        unloadPlugin: jest.fn(async () => {}),
        setPluginError: jest.fn(),
        setPluginStatus: jest.fn(),
      }
      mockGetState.mockReturnValue(store)

      const wasmManifest: PluginManifest = {
        id: "demo.wasm",
        name: "Demo WASM",
        version: "0.1.0",
        description: "x",
        type: "wasm",
        capabilities: [],
        wasmMain: "main.wasm",
        wasm: { apiVersion: "0.1.0" },
        permissions: ["notification"],
      }

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "plugin_install") {
          return { manifest: wasmManifest, path: "/plugins/demo.wasm" }
        }
        if (cmd === "plugin_wasm_load") {
          return { pluginApiVersion: "0.1.0" }
        }
        return undefined
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const plugin = await manager.installWasmPluginFromLocalFile("/tmp/demo.zip", {
        pluginId: "demo.wasm",
        grantedPermissions: ["notification"],
        grantedPreopens: [],
      })

      expect(plugin?.manifest.id).toBe("demo.wasm")
      expect(mockInvoke).toHaveBeenCalledWith(
        "plugin_install",
        expect.objectContaining({ source: "/tmp/demo.zip", installType: "local" })
      )
      expect(mockInvoke).toHaveBeenCalledWith(
        "plugin_wasm_load",
        expect.objectContaining({
          pluginId: "demo.wasm",
          pluginPath: "/plugins/demo.wasm",
        })
      )
    })

    it("installWasmPluginFromLocalFile rejects non-wasm bundles", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn((manifest: PluginManifest, source: string, path: string) => {
          store.plugins[manifest.id] = {
            manifest,
            status: "discovered",
            source: source as never,
            path,
            config: {},
          }
        }),
        installPlugin: jest.fn(async (pluginId: string) => {
          const p = store.plugins[pluginId]
          if (p) store.plugins[pluginId] = { ...p, status: "installed" }
        }),
      }
      mockGetState.mockReturnValue(store)

      mockInvoke.mockResolvedValueOnce({
        manifest: createManifest("regular"),
        path: "/plugins/regular",
      })
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await expect(manager.installWasmPluginFromLocalFile("/tmp/regular.zip")).rejects.toThrow(
        /did not declare type: "wasm"/
      )
    })
  })

  describe("scanPlugins", () => {
    it("discovers browser built-ins without calling native directory scan in browser runtime", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn(
          (
            manifest: PluginManifest,
            source: string,
            path: string,
            options?: Record<string, unknown>
          ) => {
            store.plugins[manifest.id] = {
              manifest,
              status: "discovered",
              source: source as never,
              path,
              descriptor: options?.descriptor as Plugin["descriptor"],
              config: {},
            }
          }
        ),
        installPlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = {
            ...plugin,
            status: "installed",
            installedAt: new Date(),
          }
        }),
      }

      mockGetState.mockReturnValue(store)

      const manager = new PluginManager({
        pluginDirectory: "",
        runtimeProfile: "browser",
      })

      await manager.scanPlugins()

      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_scan_directory", expect.anything())
      expect(store.discoverPlugin).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cognia-clipboard-tools" }),
        "builtin",
        "builtin://cognia-clipboard-tools",
        expect.objectContaining({
          installRootKind: "builtin",
          descriptor: expect.objectContaining({
            installRoot: expect.objectContaining({ kind: "builtin" }),
          }),
        })
      )
    })

    it("marks desktop-only built-ins as blocked in browser runtime compatibility metadata", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn(
          (
            manifest: PluginManifest,
            source: string,
            path: string,
            options?: Record<string, unknown>
          ) => {
            store.plugins[manifest.id] = {
              manifest,
              status: "discovered",
              source: source as never,
              path,
              descriptor: options?.descriptor as Plugin["descriptor"],
              config: {},
            }
          }
        ),
        installPlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = {
            ...plugin,
            status: "installed",
            installedAt: new Date(),
          }
        }),
      }

      mockGetState.mockReturnValue(store)

      const manager = new PluginManager({
        pluginDirectory: "",
        runtimeProfile: "browser",
      })

      await manager.scanPlugins()

      expect(store.discoverPlugin).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cognia-workspace-tools" }),
        "builtin",
        "builtin://cognia-workspace-tools",
        expect.objectContaining({
          compatibilityDiagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: "runtime.browser.unsupported",
              severity: "error",
            }),
          ]),
        })
      )
    })

    it("should mark newly scanned plugins as installed in store", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn((manifest: PluginManifest, source: string, path: string) => {
          store.plugins[manifest.id] = {
            manifest,
            status: "discovered",
            source: source as never,
            path,
            config: {},
          }
        }),
        installPlugin: jest.fn(async (pluginId: string) => {
          const p = store.plugins[pluginId]
          if (p) {
            store.plugins[pluginId] = {
              ...p,
              status: "installed",
              installedAt: new Date(),
            }
          }
        }),
      }

      mockGetState.mockReturnValue(store)

      const manifest = createManifest("scanned-plugin")
      mockInvoke.mockResolvedValueOnce([
        {
          manifest,
          path: "/plugins/scanned-plugin",
        },
      ])

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await manager.scanPlugins()

      expect(store.plugins["scanned-plugin"]).toBeDefined()
      expect(store.plugins["scanned-plugin"].status).toBe("installed")
      expect(store.plugins["scanned-plugin"].installedAt).toEqual(expect.any(Date))
      // With requireSignatures=false and allowUntrusted=true, verify is skipped
    })

    it("should pass through backend source metadata when scanning plugins", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn((manifest: PluginManifest, source: string, path: string) => {
          store.plugins[manifest.id] = {
            manifest,
            status: "discovered",
            source: source as never,
            path,
            config: {},
          }
        }),
        installPlugin: jest.fn(async (pluginId: string) => {
          const p = store.plugins[pluginId]
          if (p) {
            store.plugins[pluginId] = {
              ...p,
              status: "installed",
              installedAt: new Date(),
            }
          }
        }),
      }

      mockGetState.mockReturnValue(store)

      const manifest = createManifest("dev-scanned-plugin")
      mockInvoke.mockResolvedValueOnce([
        {
          manifest,
          path: "/plugins/dev-scanned-plugin",
          source: "dev",
          installRootKind: "dev",
        },
      ])

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await manager.scanPlugins()

      expect(store.discoverPlugin).toHaveBeenCalledWith(
        manifest,
        "dev",
        "/plugins/dev-scanned-plugin",
        expect.objectContaining({
          installRootKind: "dev",
          descriptor: expect.objectContaining({
            source: "dev",
            installRoot: expect.objectContaining({ kind: "dev" }),
          }),
        })
      )
    })

    it("refreshes existing plugin identity when scan reports a new source", async () => {
      const manifest = createManifest("source-shift-plugin")
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {
          "source-shift-plugin": {
            manifest,
            status: "enabled",
            source: "local",
            path: "/plugins/source-shift-plugin",
            config: {},
          },
        },
        discoverPlugin: jest.fn(
          (
            nextManifest: PluginManifest,
            source: string,
            path: string,
            options?: Record<string, unknown>
          ) => {
            const existing = store.plugins[nextManifest.id]
            store.plugins[nextManifest.id] = {
              ...existing,
              manifest: nextManifest,
              source: source as never,
              path,
              descriptor: options?.descriptor as Plugin["descriptor"],
            } as Plugin
          }
        ),
        installPlugin: jest.fn(async () => undefined),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValueOnce([
        {
          manifest,
          path: "/plugins/source-shift-plugin",
          source: "marketplace",
          installRootKind: "installed",
        },
      ])

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await manager.scanPlugins()

      expect(store.discoverPlugin).toHaveBeenCalledWith(
        manifest,
        "marketplace",
        "/plugins/source-shift-plugin",
        expect.objectContaining({
          descriptor: expect.objectContaining({
            identity: expect.objectContaining({
              canonicalId: "source-shift-plugin",
              observedSources: ["local", "marketplace"],
              activeSource: "marketplace",
            }),
          }),
        })
      )
      expect(store.installPlugin).not.toHaveBeenCalled()
    })

    it("should skip invalid manifests", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn(),
        installPlugin: jest.fn(async () => undefined),
      }

      mockGetState.mockReturnValue(store)

      const invalidManifest: PluginManifest = {
        id: "invalid-plugin",
        name: "Invalid",
        version: "1.0.0",
        description: "missing main",
        type: "frontend",
        capabilities: ["tools"],
      }

      mockInvoke.mockResolvedValueOnce([
        {
          manifest: invalidManifest,
          path: "/plugins/invalid-plugin",
        },
      ])

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await manager.scanPlugins()

      expect(store.discoverPlugin).not.toHaveBeenCalled()
      expect(store.plugins["invalid-plugin"]).toBeUndefined()
    })

    it("surfaces capability validation diagnostics through descriptor compatibility metadata", async () => {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
      } = {
        plugins: {},
        discoverPlugin: jest.fn((manifest: PluginManifest, source: string, path: string) => {
          store.plugins[manifest.id] = {
            manifest,
            status: "discovered",
            source: source as never,
            path,
            config: {},
          }
        }),
        installPlugin: jest.fn(async (pluginId: string) => {
          const p = store.plugins[pluginId]
          if (p) {
            store.plugins[pluginId] = {
              ...p,
              status: "installed",
              installedAt: new Date(),
            }
          }
        }),
      }

      mockGetState.mockReturnValue(store)

      const manifest: PluginManifest = {
        ...createManifest("themes-plugin"),
        capabilities: ["themes"],
      }

      mockInvoke.mockResolvedValueOnce([
        {
          manifest,
          path: "/plugins/themes-plugin",
        },
      ])

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await manager.scanPlugins()

      expect(store.discoverPlugin).toHaveBeenCalledWith(
        manifest,
        "local",
        "/plugins/themes-plugin",
        expect.objectContaining({
          compatibilityDiagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: "manifest.capabilities.plugin.capability.partial",
              severity: "warning",
            }),
          ]),
          descriptor: expect.objectContaining({
            compatibility: expect.objectContaining({
              diagnostics: expect.arrayContaining([
                expect.objectContaining({
                  code: "manifest.capabilities.plugin.capability.partial",
                  severity: "warning",
                }),
              ]),
            }),
          }),
        })
      )
    })
  })

  describe("browser runtime activation", () => {
    it("loads a browser-compatible builtin plugin and registers its tools", async () => {
      Object.defineProperty(global.navigator, "clipboard", {
        configurable: true,
        value: {
          readText: jest.fn().mockResolvedValue("browser clipboard"),
          writeText: jest.fn().mockResolvedValue(undefined),
        },
      })

      const store = {
        plugins: {} as Record<string, Plugin>,
        discoverPlugin: jest.fn(
          (
            manifest: PluginManifest,
            source: string,
            path: string,
            options?: Record<string, unknown>
          ) => {
            store.plugins[manifest.id] = {
              manifest,
              status: "discovered",
              source: source as never,
              path,
              descriptor: options?.descriptor as Plugin["descriptor"],
              config: {},
            }
          }
        ),
        installPlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = {
            ...plugin,
            status: "installed",
            installedAt: new Date(),
          }
        }),
        loadPlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, status: "loaded" }
        }),
        enablePlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, status: "enabled" }
        }),
        registerPluginHooks: jest.fn(),
        registerPluginTool: jest.fn(
          (pluginId: string, tool: NonNullable<Plugin["tools"]>[number]) => {
            const plugin = store.plugins[pluginId]
            store.plugins[pluginId] = {
              ...plugin,
              tools: [...(plugin.tools || []), tool],
            }
          }
        ),
        registerPluginCommand: jest.fn(
          (pluginId: string, command: NonNullable<Plugin["commands"]>[number]) => {
            const plugin = store.plugins[pluginId]
            store.plugins[pluginId] = {
              ...plugin,
              commands: [...(plugin.commands || []), command],
            }
          }
        ),
        setPluginError: jest.fn(),
        setPluginVerificationSnapshot: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValue(undefined)

      const manager = new PluginManager({
        pluginDirectory: "",
        runtimeProfile: "browser",
      })

      await manager.scanPlugins()
      await manager.enablePlugin("cognia-clipboard-tools")

      expect(store.registerPluginTool).toHaveBeenCalledWith(
        "cognia-clipboard-tools",
        expect.objectContaining({ name: "clipboard_status" })
      )
      expect(manager.getRegistry().getTool("clipboard_status")).toBeDefined()
      expect(store.plugins["cognia-clipboard-tools"].status).toBe("enabled")
    })
  })

  describe("syncRuntimeState", () => {
    it("skips backend sync when the native invoke bridge is unavailable", async () => {
      const store = {
        plugins: {} as Record<string, Plugin>,
      }

      mockGetState.mockReturnValue(store)
      mockCanUseTauriInvoke.mockReturnValue(false)

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await manager.syncRuntimeState()

      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_runtime_snapshot")
      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_get_all")
    })
  })

  describe("uninstallPlugin", () => {
    it("should call plugin_uninstall and then store.uninstallPlugin with skipFileRemoval=true", async () => {
      const manifest = createManifest("to-remove")

      const store: {
        plugins: Record<string, Plugin>
        uninstallPlugin: jest.Mock
        unloadPlugin: jest.Mock
        setPluginError: jest.Mock
        setPluginStatus: jest.Mock
      } = {
        plugins: {
          "to-remove": {
            manifest,
            status: "installed",
            source: "local",
            path: "/plugins/to-remove",
            config: {},
          },
        },
        uninstallPlugin: jest.fn(async () => undefined),
        unloadPlugin: jest.fn(async () => undefined),
        // Catch path inside PluginManager.uninstallPlugin calls these when the
        // cleanup phase (removePluginTables, revokePermissions) throws — the
        // mock store needs them as no-op spies so the catch doesn't blow up
        // with `setPluginError is not a function` masking the real assertion.
        setPluginError: jest.fn(),
        setPluginStatus: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValueOnce(undefined)

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await manager.uninstallPlugin("to-remove")

      expect(mockInvoke).toHaveBeenCalledWith("plugin_uninstall", {
        pluginId: "to-remove",
        pluginPath: "/plugins/to-remove",
      })

      expect(store.uninstallPlugin).toHaveBeenCalledWith("to-remove", {
        skipFileRemoval: true,
        viaManager: false,
      })
    })
  })

  describe("disablePlugin", () => {
    it("should call plugin deactivate and unregister contributions", async () => {
      const manifest = {
        ...createManifest("to-disable"),
        permissions: ["network:fetch"],
      }
      const store = {
        plugins: {
          "to-disable": {
            manifest,
            status: "enabled",
            source: "local",
            path: "/plugins/to-disable",
            config: {},
            tools: [
              {
                name: "tool-a",
                pluginId: "to-disable",
                definition: { name: "tool-a", description: "Tool A", parametersSchema: {} },
                execute: jest.fn(),
              },
            ],
            components: [
              {
                type: "component-a",
                pluginId: "to-disable",
                component: () => null,
                metadata: { type: "component-a", name: "Component A" },
              },
            ],
            modes: [
              {
                id: "to-disable:mode-a",
                type: "custom",
                name: "Mode A",
                description: "Mode A",
                icon: "bot",
                tools: [],
              },
            ],
            commands: [
              {
                id: "to-disable.command-a",
                name: "Command A",
                execute: jest.fn(),
              },
            ],
          },
        } as Record<string, Plugin>,
        disablePlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, status: "disabled" } as Plugin
        }),
        unregisterPluginTool: jest.fn(),
        unregisterPluginComponent: jest.fn(),
        unregisterPluginMode: jest.fn(),
        unregisterPluginCommand: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValue(undefined)

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const deactivate = jest.fn(async () => undefined)
      ;(
        manager as unknown as {
          loader: {
            loadedModules: Map<string, { definition: { deactivate: () => Promise<void> } }>
          }
        }
      ).loader.loadedModules.set("to-disable", {
        definition: { deactivate },
      })

      await manager.disablePlugin("to-disable")

      expect(store.disablePlugin).toHaveBeenCalledWith("to-disable", { viaManager: false })
      expect(store.unregisterPluginTool).toHaveBeenCalledWith("to-disable", "tool-a")
      expect(store.unregisterPluginComponent).toHaveBeenCalledWith("to-disable", "component-a")
      expect(store.unregisterPluginMode).toHaveBeenCalledWith("to-disable", "to-disable:mode-a")
      expect(store.unregisterPluginCommand).toHaveBeenCalledWith(
        "to-disable",
        "to-disable.command-a"
      )
      expect(deactivate).toHaveBeenCalled()
      expect(mockGuard.revokeAll).toHaveBeenCalledWith("to-disable")
    })

    it("records a failure snapshot and preserves last known good verification when disable fails", async () => {
      const manifest = createManifest("disable-failure")
      const store = {
        plugins: {
          "disable-failure": {
            manifest,
            status: "enabled",
            source: "local",
            path: "/plugins/disable-failure",
            config: {},
            verificationSnapshot: {
              pluginId: "disable-failure",
              source: "local",
              status: "enabled",
              verificationStage: "activation",
              lastVerifiedAction: "enable",
              lastVerifiedAt: "2026-03-16T00:00:00.000Z",
              lastSuccessfulAt: "2026-03-16T00:00:00.000Z",
              diagnostics: [],
            },
            lastKnownGoodVerification: {
              pluginId: "disable-failure",
              source: "local",
              status: "enabled",
              verificationStage: "activation",
              lastVerifiedAction: "enable",
              lastVerifiedAt: "2026-03-16T00:00:00.000Z",
              lastSuccessfulAt: "2026-03-16T00:00:00.000Z",
              diagnostics: [],
            },
          },
        } as Record<string, Plugin>,
        disablePlugin: jest.fn(async () => undefined),
        unregisterPluginTool: jest.fn(),
        unregisterPluginComponent: jest.fn(),
        unregisterPluginMode: jest.fn(),
        unregisterPluginCommand: jest.fn(),
        setPluginError: jest.fn(),
        setPluginVerificationSnapshot: jest.fn(),
      }

      mockGetState.mockReturnValue(store)

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const deactivate = jest.fn(async () => {
        throw new Error("deactivate failed")
      })
      ;(
        manager as unknown as {
          loader: {
            loadedModules: Map<string, { definition: { deactivate: () => Promise<void> } }>
          }
        }
      ).loader.loadedModules.set("disable-failure", {
        definition: { deactivate },
      })

      await expect(manager.disablePlugin("disable-failure")).rejects.toThrow(/deactivate failed/i)

      expect(store.setPluginError).toHaveBeenCalledWith("disable-failure", "deactivate failed")
      expect(store.setPluginVerificationSnapshot).toHaveBeenCalledWith(
        "disable-failure",
        expect.objectContaining({
          status: "error",
          verificationStage: "cleanup",
          lastVerifiedAction: "disable",
          lastFailureAt: expect.any(String),
          lastSuccessfulAt: "2026-03-16T00:00:00.000Z",
        })
      )
    })

    it("restores runtime registrations when disable fails after cleanup has started", async () => {
      const manifest = {
        ...createManifest("rollback-plugin"),
        permissions: ["network:fetch" as const],
        commands: [
          {
            id: "command-a",
            name: "Command A",
          },
        ],
      }

      const tool = {
        name: "tool-a",
        pluginId: "rollback-plugin",
        definition: { name: "tool-a", description: "Tool A", parametersSchema: {} },
        execute: jest.fn(),
      }

      const pluginHooks = {
        onDisable: jest.fn(),
      }

      const runtimeCommand = {
        id: "rollback-plugin.command-a",
        name: "Command A",
        execute: jest.fn(),
      }

      const store = {
        plugins: {
          "rollback-plugin": {
            manifest,
            status: "enabled",
            source: "local",
            path: "/plugins/rollback-plugin",
            config: {},
            hooks: pluginHooks,
            tools: [tool],
            commands: [runtimeCommand],
          },
        } as Record<string, Plugin>,
        disablePlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, status: "disabled" } as Plugin
        }),
        unregisterPluginTool: jest.fn((pluginId: string, toolName: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = {
            ...plugin,
            tools: (plugin.tools || []).filter((entry) => entry.name !== toolName),
          } as Plugin
        }),
        unregisterPluginComponent: jest.fn(),
        unregisterPluginMode: jest.fn(),
        unregisterPluginCommand: jest.fn((pluginId: string, commandId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = {
            ...plugin,
            commands: (plugin.commands || []).filter((entry) => entry.id !== commandId),
          } as Plugin
        }),
        registerPluginHooks: jest.fn((pluginId: string, hooks: Plugin["hooks"]) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, hooks } as Plugin
        }),
        registerPluginTool: jest.fn((pluginId: string, restoredTool: typeof tool) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = {
            ...plugin,
            tools: [
              ...(plugin.tools || []).filter((entry) => entry.name !== restoredTool.name),
              restoredTool,
            ],
          } as Plugin
        }),
        registerPluginCommand: jest.fn((pluginId: string, command: typeof runtimeCommand) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = {
            ...plugin,
            commands: [
              ...(plugin.commands || []).filter((entry) => entry.id !== command.id),
              command,
            ],
          } as Plugin
        }),
        setPluginStatus: jest.fn((pluginId: string, status: Plugin["status"]) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, status } as Plugin
        }),
        setPluginError: jest.fn((pluginId: string, error: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, error, status: "error" } as Plugin
        }),
        setPluginVerificationSnapshot: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValue(undefined)

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const deactivate = jest.fn(async () => undefined)
      ;(
        manager as unknown as {
          loader: {
            loadedModules: Map<
              string,
              {
                definition: {
                  manifest: PluginManifest
                  activate: () => unknown
                  deactivate: () => Promise<void>
                }
                exports: Record<string, unknown>
              }
            >
          }
        }
      ).loader.loadedModules.set("rollback-plugin", {
        definition: { manifest, activate: jest.fn(), deactivate },
        exports: { default: {} },
      })
      ;(manager as unknown as { contexts: Map<string, unknown> }).contexts.set(
        "rollback-plugin",
        {}
      )
      manager.getHooksManager().registerHooks("rollback-plugin", pluginHooks)
      manager.getRegistry().registerTool("rollback-plugin", tool)
      manager.getRegistry().registerCommand("rollback-plugin", runtimeCommand as never)
      createExtensionAPI("rollback-plugin").registerExtension("chat.header", () => null)

      jest
        .spyOn(
          manager as unknown as {
            revokePluginPermissions: (pluginId: string, permissions: string[]) => Promise<void>
          },
          "revokePluginPermissions"
        )
        .mockRejectedValueOnce(new Error("revoke failed"))

      await expect(manager.disablePlugin("rollback-plugin")).rejects.toThrow(/revoke failed/i)

      expect(store.plugins["rollback-plugin"].status).toBe("enabled")
      expect(manager.getPluginContext("rollback-plugin")).toBeDefined()
      expect(
        (
          manager as unknown as { loader: { getDefinition: (pluginId: string) => unknown } }
        ).loader.getDefinition("rollback-plugin")
      ).toBeDefined()
      expect(manager.getRegistry().getTool("tool-a")).toBeDefined()
      expect(manager.getRegistry().getCommand("rollback-plugin.command-a")).toBeDefined()
      expect(getPluginExtensionRegistrationCount("rollback-plugin")).toBe(1)
    })
  })

  describe("handleActivationEvent", () => {
    it("should activate plugin when command activation event matches", async () => {
      const pluginA: Plugin = {
        manifest: {
          ...createManifest("event-plugin"),
          activationEvents: ["onCommand:test-command"],
        },
        status: "installed",
        source: "local",
        path: "/plugins/event-plugin",
        config: {},
      }
      const pluginB: Plugin = {
        manifest: {
          ...createManifest("other-plugin"),
          activationEvents: ["onCommand:other-command"],
        },
        status: "installed",
        source: "local",
        path: "/plugins/other-plugin",
        config: {},
      }

      mockGetState.mockReturnValue({
        plugins: {
          "event-plugin": pluginA,
          "other-plugin": pluginB,
        },
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("onCommand:test-command")

      expect(enableSpy).toHaveBeenCalledWith("event-plugin", "activation:onCommand:test-command")
      expect(enableSpy).not.toHaveBeenCalledWith("other-plugin", expect.any(String))
    })

    it("should activate plugin when wildcard command activation event matches", async () => {
      const wildcardPlugin: Plugin = {
        manifest: {
          ...createManifest("wildcard-plugin"),
          activationEvents: ["onCommand:git-tools.*"],
        },
        status: "installed",
        source: "local",
        path: "/plugins/wildcard-plugin",
        config: {},
      }

      mockGetState.mockReturnValue({
        plugins: {
          "wildcard-plugin": wildcardPlugin,
        },
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("onCommand:git-tools.status")

      expect(enableSpy).toHaveBeenCalledWith(
        "wildcard-plugin",
        "activation:onCommand:git-tools.status"
      )
    })

    it("should activate plugin on startup event when activateOnStartup=true", async () => {
      const startupPlugin: Plugin = {
        manifest: {
          ...createManifest("startup-plugin"),
          activateOnStartup: true,
        },
        status: "installed",
        source: "local",
        path: "/plugins/startup-plugin",
        config: {},
      }

      mockGetState.mockReturnValue({
        plugins: {
          "startup-plugin": startupPlugin,
        },
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("startup")

      expect(enableSpy).toHaveBeenCalledWith("startup-plugin", "activation:startup")
    })

    it("should activate plugin for legacy onAgentTool activation events", async () => {
      const legacyToolPlugin: Plugin = {
        manifest: {
          ...createManifest("legacy-tool-plugin"),
          activationEvents: ["onAgentTool:docker_*"],
        },
        status: "installed",
        source: "local",
        path: "/plugins/legacy-tool-plugin",
        config: {},
      }

      mockGetState.mockReturnValue({
        plugins: {
          "legacy-tool-plugin": legacyToolPlugin,
        },
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("onTool:docker_ps")

      expect(enableSpy).toHaveBeenCalledWith("legacy-tool-plugin", "activation:onTool:docker_ps")
    })

    it("should activate plugin for an onView activation event (exact + wildcard)", async () => {
      const exactView: Plugin = {
        manifest: {
          ...createManifest("view-plugin"),
          activationEvents: ["onView:settings.plugins"],
        },
        status: "installed",
        source: "local",
        path: "/plugins/view-plugin",
        config: {},
      }
      const wildcardView: Plugin = {
        manifest: {
          ...createManifest("inbox-view-plugin"),
          activationEvents: ["onView:inbox.*"],
        },
        status: "installed",
        source: "local",
        path: "/plugins/inbox-view-plugin",
        config: {},
      }
      mockGetState.mockReturnValue({
        plugins: { "view-plugin": exactView, "inbox-view-plugin": wildcardView },
      })
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("onView:settings.plugins")
      expect(enableSpy).toHaveBeenCalledWith("view-plugin", "activation:onView:settings.plugins")

      await manager.handleActivationEvent("onView:inbox.sidebar.section")
      expect(enableSpy).toHaveBeenCalledWith(
        "inbox-view-plugin",
        "activation:onView:inbox.sidebar.section"
      )
    })

    it("does not cross-activate: an onView event never matches an onCommand/onTool plugin", async () => {
      // Regression for the old fall-through bug where any non-startup/
      // non-onCommand event was sliced as `onTool:` and could mis-match.
      const cmdPlugin: Plugin = {
        manifest: {
          ...createManifest("cmd-only-plugin"),
          activationEvents: ["onCommand:settings.plugins"],
        },
        status: "installed",
        source: "local",
        path: "/plugins/cmd-only-plugin",
        config: {},
      }
      mockGetState.mockReturnValue({ plugins: { "cmd-only-plugin": cmdPlugin } })
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("onView:settings.plugins")
      expect(enableSpy).not.toHaveBeenCalled()
    })
  })

  describe("plugin slash command integration", () => {
    const createCommandPlugin = (status: Plugin["status"] = "loaded"): Plugin => ({
      manifest: {
        ...createManifest("cmd-plugin"),
        capabilities: ["commands"],
        commands: [
          {
            id: "cmd-plugin.run",
            name: "Run Command",
            description: "Execute plugin command",
            aliases: ["cmd-run", "cmd-alias"],
          },
        ],
      },
      status,
      source: "local",
      path: "/plugins/cmd-plugin",
      config: {},
    })

    it("should register slash commands when plugin is enabled", async () => {
      const store = {
        plugins: {
          "cmd-plugin": createCommandPlugin("loaded"),
        } as Record<string, Plugin>,
        enablePlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, status: "enabled" }
        }),
        registerPluginCommand: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      ;(manager as unknown as { contexts: Map<string, unknown> }).contexts.set("cmd-plugin", {})
      ;(
        manager as unknown as { loader: { isLoaded: (pluginId: string) => boolean } }
      ).loader.isLoaded = jest.fn(() => true)

      await manager.enablePlugin("cmd-plugin")

      expect(store.enablePlugin).toHaveBeenCalledWith("cmd-plugin", { viaManager: false })
      expect(store.registerPluginCommand).toHaveBeenCalledWith(
        "cmd-plugin",
        expect.objectContaining({ id: "cmd-plugin.cmd-plugin.run" })
      )
      // The manager registers each command as a separate
      // `SlashCommandDefinition` against the real registry — once for
      // the canonical id, once per alias under `${id}#alias:${alias}`.
      expect(mockRegisterSlashCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "cmd-plugin.cmd-plugin.run",
          name: "Run Command",
          source: "plugin",
          pluginId: "cmd-plugin",
        })
      )
      expect(mockRegisterSlashCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "cmd-plugin.cmd-plugin.run#alias:cmd-run",
          source: "plugin",
          pluginId: "cmd-plugin",
        })
      )
      expect(mockRegisterSlashCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "cmd-plugin.cmd-plugin.run#alias:cmd-alias",
          source: "plugin",
          pluginId: "cmd-plugin",
        })
      )
    })

    it("should unregister slash commands when plugin is disabled", async () => {
      const store = {
        plugins: {
          "cmd-plugin": {
            ...createCommandPlugin("enabled"),
            commands: [
              {
                id: "cmd-plugin.cmd-plugin.run",
                name: "Run Command",
                execute: jest.fn(),
              },
            ],
          },
        } as Record<string, Plugin>,
        disablePlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, status: "disabled" }
        }),
        unregisterPluginCommand: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      ;(
        manager as unknown as {
          registeredSlashCommandsByPlugin: Map<string, string[]>
        }
      ).registeredSlashCommandsByPlugin.set("cmd-plugin", ["cmd-plugin.run"])

      await manager.disablePlugin("cmd-plugin")

      expect(store.disablePlugin).toHaveBeenCalledWith("cmd-plugin", { viaManager: false })
      expect(mockUnregisterSlashCommand).toHaveBeenCalledWith("cmd-plugin.run")
    })

    it("should skip conflicting slash alias while registering non-conflicting aliases", async () => {
      const store = {
        plugins: {
          "cmd-plugin": createCommandPlugin("loaded"),
        } as Record<string, Plugin>,
        enablePlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, status: "enabled" }
        }),
        registerPluginCommand: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      // Each alias is registered under `${id}#alias:${alias}` — return an
      // existing entry for the `cmd-alias` namespaced id so the manager
      // skips that alias but still registers the others.
      mockGetSlashCommand.mockImplementation((id: string) =>
        id === "cmd-plugin.cmd-plugin.run#alias:cmd-alias"
          ? ({
              id,
              name: "existing",
              source: "plugin",
              handler: async () => ({}),
            } as never)
          : undefined
      )

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      ;(manager as unknown as { contexts: Map<string, unknown> }).contexts.set("cmd-plugin", {})
      ;(
        manager as unknown as { loader: { isLoaded: (pluginId: string) => boolean } }
      ).loader.isLoaded = jest.fn(() => true)

      await manager.enablePlugin("cmd-plugin")

      // Canonical + non-conflicting alias should register.
      expect(mockRegisterSlashCommand).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cmd-plugin.cmd-plugin.run" })
      )
      expect(mockRegisterSlashCommand).toHaveBeenCalledWith(
        expect.objectContaining({ id: "cmd-plugin.cmd-plugin.run#alias:cmd-run" })
      )
      // The conflicting alias must NOT have been registered.
      const conflictRegistered = mockRegisterSlashCommand.mock.calls.some(
        (call) =>
          (call[0] as { id?: string } | undefined)?.id ===
          "cmd-plugin.cmd-plugin.run#alias:cmd-alias"
      )
      expect(conflictRegistered).toBe(false)
    })
  })

  describe("plugin point governance", () => {
    it("blocks retired activation events in block mode", async () => {
      const manager = new PluginManager({
        pluginDirectory: "/plugins",
        pluginPointGovernanceMode: "block",
      })

      const manifest: PluginManifest = {
        ...createManifest("blocked-activation"),
        activationEvents: ["onLanguage:typescript"],
      }

      expect(() =>
        (
          manager as unknown as { parseActivationSpec: (m: PluginManifest) => unknown }
        ).parseActivationSpec(manifest)
      ).toThrow(/blocked by plugin point governance mode/i)
    })

    it("blocks unknown hook declarations in block mode", () => {
      const manager = new PluginManager({
        pluginDirectory: "/plugins",
        pluginPointGovernanceMode: "block",
      })

      const hooks = {
        onLoad: jest.fn(),
        onUnknownHookName: jest.fn(),
      }

      expect(() =>
        (
          manager as unknown as {
            validateHookDeclarations: (pluginId: string, hooksObj: Record<string, unknown>) => void
          }
        ).validateHookDeclarations("hook-plugin", hooks)
      ).toThrow(/blocked by plugin point governance mode/i)
    })

    it("setPluginPointGovernanceMode updates the live mode without a restart", () => {
      const manager = new PluginManager({
        pluginDirectory: "/plugins",
        pluginPointGovernanceMode: "warn",
      })
      expect(manager.getPluginPointGovernanceMode()).toBe("warn")

      manager.setPluginPointGovernanceMode("block")
      expect(manager.getPluginPointGovernanceMode()).toBe("block")

      const manifest: PluginManifest = {
        ...createManifest("toggled-activation"),
        activationEvents: ["onLanguage:typescript"],
      }
      expect(() =>
        (
          manager as unknown as { parseActivationSpec: (m: PluginManifest) => unknown }
        ).parseActivationSpec(manifest)
      ).toThrow(/blocked by plugin point governance mode/i)

      manager.setPluginPointGovernanceMode("warn")
      expect(manager.getPluginPointGovernanceMode()).toBe("warn")
    })
  })

  describe("resolveGovernanceMode", () => {
    const ORIGINAL_ENV = process.env.COGNIA_PLUGIN_POINT_GOVERNANCE_MODE

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) {
        delete process.env.COGNIA_PLUGIN_POINT_GOVERNANCE_MODE
      } else {
        process.env.COGNIA_PLUGIN_POINT_GOVERNANCE_MODE = ORIGINAL_ENV
      }
    })

    it("defaults to warn when nothing is configured", () => {
      delete process.env.COGNIA_PLUGIN_POINT_GOVERNANCE_MODE
      expect(resolveGovernanceMode()).toBe("warn")
    })

    it("uses configured value when env override is unset", () => {
      delete process.env.COGNIA_PLUGIN_POINT_GOVERNANCE_MODE
      expect(resolveGovernanceMode("block")).toBe("block")
    })

    it("env override wins over configured value (block)", () => {
      process.env.COGNIA_PLUGIN_POINT_GOVERNANCE_MODE = "block"
      expect(resolveGovernanceMode("warn")).toBe("block")
    })

    it("env override wins over configured value (warn)", () => {
      process.env.COGNIA_PLUGIN_POINT_GOVERNANCE_MODE = "warn"
      expect(resolveGovernanceMode("block")).toBe("warn")
    })

    it("ignores invalid env values", () => {
      process.env.COGNIA_PLUGIN_POINT_GOVERNANCE_MODE = "nonsense"
      expect(resolveGovernanceMode("block")).toBe("block")
    })
  })

  describe("Factory + __resetForTesting (PR-E)", () => {
    beforeEach(() => {
      try {
        __resetPluginManagerForTesting()
      } catch {
        // Tests run with NODE_ENV=test in jest; ignore if env not set yet.
      }
    })

    it("createPluginManager returns a fresh instance per call", () => {
      // We deliberately avoid initializePluginManager here — that path
      // triggers store.initialize() which is mocked across this file
      // and not meaningful for the factory contract. Constructing via
      // the factory + checking inequality is enough to lock the
      // "no shared state between instances" guarantee.
      const a = createPluginManager({
        pluginDirectory: "/tmp/cognia-plugins-a",
        enablePython: false,
      })
      const b = createPluginManager({
        pluginDirectory: "/tmp/cognia-plugins-b",
        enablePython: false,
      })
      expect(a).not.toBe(b)
      expect(a).toBeInstanceOf(PluginManager)
      expect(b).toBeInstanceOf(PluginManager)
    })

    it("createPluginManager does not touch the module-level default", () => {
      // Default instance starts unset; the factory must not populate it.
      expect(() => getPluginManager()).toThrow(/not initialized/)
      createPluginManager({
        pluginDirectory: "/tmp/cognia-plugins-isolated",
        enablePython: false,
      })
      expect(() => getPluginManager()).toThrow(/not initialized/)
    })

    it("__resetPluginManagerForTesting throws outside NODE_ENV=test", () => {
      const original = process.env.NODE_ENV
      ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
      try {
        expect(() => __resetPluginManagerForTesting()).toThrow(/NODE_ENV=test/)
      } finally {
        ;(process.env as Record<string, string | undefined>).NODE_ENV = original
      }
    })

    it("initializePluginManager is mentioned in the import so future refactors stay aware", () => {
      // Identity check (not behaviour) — we just want a compile-time
      // dependency on the symbol so a future rename can't silently
      // drop the façade.
      expect(typeof initializePluginManager).toBe("function")
    })
  })

  describe("PluginEnableError (PR-A)", () => {
    it("carries pluginId and the original cause", () => {
      const original = new Error("registry blew up")
      const err = new PluginEnableError("plugin-x", original)
      expect(err).toBeInstanceOf(PluginEnableError)
      expect(err).toBeInstanceOf(Error)
      expect(err.pluginId).toBe("plugin-x")
      expect(err.originalError).toBe(original)
      expect(err.cause).toBe(original)
      expect(err.name).toBe("PluginEnableError")
      expect(err.message).toContain("plugin-x")
      expect(err.message).toContain("registry blew up")
    })

    it("coerces non-Error causes via String()", () => {
      const err = new PluginEnableError("plugin-y", "string failure")
      expect(err.originalError).toBe("string failure")
      expect(err.message).toContain("string failure")
    })

    it("uses 'PluginEnableError' as the error name (for pattern matching)", () => {
      const err = new PluginEnableError("plugin-z", new Error("x"))
      // Callers can branch on err.name === "PluginEnableError" or use
      // `err instanceof PluginEnableError` interchangeably.
      expect(err.name).toBe("PluginEnableError")
    })
  })

  describe("required-dependency gate (load-order)", () => {
    // The gate runs before any load work, so a minimal store (just the
    // dependent + whatever deps the scenario needs) is enough; we never reach
    // loadPlugin on the blocked paths.
    const mkPlugin = (
      id: string,
      overrides: Partial<PluginManifest> = {},
      status: Plugin["status"] = "installed"
    ): Plugin => ({
      manifest: { ...createManifest(id), ...overrides },
      status,
      source: "local" as never,
      path: `/plugins/${id}`,
      config: {},
    })

    beforeEach(() => {
      __resetDiagnosticsStoreForTesting()
    })

    it("blocks enable when a required dependency is missing + records a diagnostic", async () => {
      const store = {
        plugins: { b: mkPlugin("b", { dependencies: { a: "^1.0.0" } }) },
        enablePlugin: jest.fn(),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await expect(manager.enablePlugin("b")).rejects.toBeInstanceOf(PluginDependencyError)
      expect(store.enablePlugin).not.toHaveBeenCalled()
      expect(
        getPluginPointDiagnostics("b").some((d) => d.code === "plugin.dependency.missing")
      ).toBe(true)
    })

    it("blocks enable when a required dependency is disabled", async () => {
      const store = {
        plugins: {
          a: mkPlugin("a", {}, "disabled"),
          b: mkPlugin("b", { dependencies: { a: "*" } }),
        },
        enablePlugin: jest.fn(),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await expect(manager.enablePlugin("b")).rejects.toBeInstanceOf(PluginDependencyError)
      expect(
        getPluginPointDiagnostics("b").some((d) => d.code === "plugin.dependency.disabled")
      ).toBe(true)
    })

    it("blocks enable on a required-dependency version mismatch", async () => {
      const store = {
        plugins: {
          a: mkPlugin("a", { version: "1.0.0" }),
          b: mkPlugin("b", { dependencies: { a: "^2.0.0" } }),
        },
        enablePlugin: jest.fn(),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await expect(manager.enablePlugin("b")).rejects.toBeInstanceOf(PluginDependencyError)
      expect(
        getPluginPointDiagnostics("b").some((d) => d.code === "plugin.dependency.version-mismatch")
      ).toBe(true)
    })

    it("blocks enable when the plugin is part of a dependency cycle", async () => {
      const store = {
        plugins: {
          a: mkPlugin("a", { dependencies: { b: "*" } }),
          b: mkPlugin("b", { dependencies: { a: "*" } }),
        },
        enablePlugin: jest.fn(),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await expect(manager.enablePlugin("a")).rejects.toBeInstanceOf(PluginDependencyError)
      expect(getPluginPointDiagnostics("a").some((d) => d.code === "plugin.dependency.cycle")).toBe(
        true
      )
    })

    it("returns early without a dependency check when the plugin is already enabled", async () => {
      const store = {
        plugins: { b: mkPlugin("b", { dependencies: { a: "*" } }, "enabled") },
        enablePlugin: jest.fn(),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      // Already enabled → no throw even though `a` is missing.
      await expect(manager.enablePlugin("b")).resolves.toBeUndefined()
    })
  })
})
