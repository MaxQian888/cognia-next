/**
 * PluginManager Tests
 */

import { invoke } from "@tauri-apps/api/core"
import {
  PluginManager,
  PluginEnableError,
  PluginDependencyError,
  PluginFrontendTrustError,
  PythonRuntimeDisabledError,
  resolveGovernanceMode,
  createPluginManager,
  getPluginManager,
  initializePluginManager,
  __resetPluginManagerForTesting,
  toClonableManifest,
} from "./manager"
import {
  getPluginPointDiagnostics,
  __resetDiagnosticsStoreForTesting,
} from "@/lib/plugin/contracts/diagnostics-store"
import type { Plugin, PluginManifest } from "@/types/plugin"
import { getPluginSignatureVerifier } from "@/lib/plugin/security/signature"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { getMessageBus, SystemEvents, resetMessageBus } from "@/lib/plugin/messaging/message-bus"
import { getPluginIPC, resetPluginIPC } from "@/lib/plugin/messaging/ipc"
import {
  createExtensionAPI,
  getPluginExtensionRegistrationCount,
  clearPluginExtensions,
} from "@/lib/plugin/api/extension-api"
import { canUseTauriInvoke } from "@/lib/native/utils"
import {
  listPluginWallpapers,
  __resetPluginWallpapersForTesting,
} from "@/lib/plugin/bridge/wallpaper-bridge"
import { listThemePacks, __resetThemePackRegistryForTesting } from "@/lib/theme/theme-pack-registry"

const mockTransportCall = jest.fn()
const mockTransportSubscribe = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: {
    call: (...args: unknown[]) => mockTransportCall(...args),
    subscribe: (...args: unknown[]) => mockTransportSubscribe(...args),
  },
}))

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: jest.fn(),
  },
}))

jest.mock("@/lib/plugin/security/signature", () => ({
  getPluginSignatureVerifier: jest.fn(),
}))

// Partial mock: keep the pure `isInherentlyTrustedFrontendSource` real, but
// stub the localStorage-backed read/write (this suite runs in the node env
// where `window` is undefined, so the real readPolicy always returns
// DEFAULT_POLICY and per-test trust grants would be impossible).
jest.mock("@/lib/plugin/core/plugins-policy-storage", () => {
  const actual = jest.requireActual("@/lib/plugin/core/plugins-policy-storage")
  return {
    ...actual,
    readPolicy: jest.fn(() => actual.DEFAULT_POLICY),
    writePolicy: jest.fn(),
  }
})

jest.mock("@/lib/plugin/security/permission-guard", () => ({
  getPermissionGuard: jest.fn(),
  createGuardedAPI: jest.fn((_pluginId, api) => api),
}))

// Inline-factory mock (avoids the outer-const TDZ trap): the broker singleton
// is closed over so `getPluginConsentBroker()` always returns the same stub,
// and `clearSessionGrantsForPlugin` is a stable spy across the suite.
jest.mock("@/lib/plugin/security/consent-broker", () => {
  const broker = { clearSessionGrantsForPlugin: jest.fn() }
  return { getPluginConsentBroker: () => broker }
})

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

jest.mock("@/lib/context-workbench/panel-registry", () => ({
  contextPanelRegistry: { unregisterPlugin: jest.fn() },
}))

// IndexedDB isn't available in this unit-test environment; the bridge would
// throw DatabaseClosedError on `applyPluginTables` / `removePluginTables`,
// blowing up uninstallPlugin's cleanup path before the assertions run.
jest.mock("@/lib/plugin/dexie/bridge", () => ({
  applyPluginTables: jest.fn(async () => undefined),
  removePluginTables: jest.fn(async () => undefined),
  restorePluginTables: jest.fn(async () => [] as string[]),
}))

// The Dexie-backed plugin row CRUD has no IndexedDB in this unit env; stub it so
// the install/update lifecycle tracking (getPlugin/updatePlugin) is observable
// without a real database.
jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(async () => undefined),
  updatePlugin: jest.fn(async () => undefined),
  upsertPlugin: jest.fn(async () => undefined),
  getPythonHostSettings: jest.fn(async () => undefined),
  setPythonHostSettings: jest.fn(async () => undefined),
}))

jest.mock("@/lib/plugin/security/wasm-grant", () => ({
  applyWasmCapabilityGrant: jest.fn(
    async (decision: { grantedPermissions?: string[]; grantedPreopens?: string[] }) => ({
      permissions: decision.grantedPermissions ?? [],
      preopens: decision.grantedPreopens ?? [],
    })
  ),
  clearWasmCapabilityGrant: jest.fn(async () => undefined),
  reconcileWasmGrantLedgerWithManifest: jest.fn(async (_pluginId: string, preopens: string[]) => ({
    allowedPreopens: [...preopens],
    deniedLedgerPreopens: [],
    ungrantedManifestPreopens: [],
  })),
}))

import { usePluginStore } from "@/stores/plugin-runtime"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { DEFAULT_POLICY, readPolicy, writePolicy } from "@/lib/plugin/core/plugins-policy-storage"
import { getPlugin, updatePlugin, upsertPlugin } from "@/lib/db/plugins"
import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { getPluginConsentBroker } from "@/lib/plugin/security/consent-broker"
import {
  applyWasmCapabilityGrant,
  clearWasmCapabilityGrant,
  reconcileWasmGrantLedgerWithManifest,
} from "@/lib/plugin/security/wasm-grant"
import {
  getSlashCommand,
  registerSlashCommand,
  unregisterSlashCommand,
} from "@/lib/chat/slash-command-registry"
import { __resetRegistryForTesting } from "@/lib/plugin/resilience/breaker-registry"
import { MODULE_BRIDGE_CAPABILITIES } from "@/lib/plugin/contracts/module-bridge-map"
import {
  __resetResilienceTelemetryForTesting,
  getRecentActivationFailures,
} from "@/lib/plugin/core/resilience-telemetry"

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
    // Used by the manifest→ledger mirror to decide silent vs confirm tier.
    getTier: jest.fn((_id: string, _perm: string) => "silent" as string),
  }
  const mockGetSlashCommand = getSlashCommand as jest.MockedFunction<typeof getSlashCommand>
  const mockRegisterSlashCommand = registerSlashCommand as jest.MockedFunction<
    typeof registerSlashCommand
  >
  const mockUnregisterSlashCommand = unregisterSlashCommand as jest.MockedFunction<
    typeof unregisterSlashCommand
  >
  const mockCanUseTauriInvoke = canUseTauriInvoke as jest.MockedFunction<typeof canUseTauriInvoke>
  const mockApplyWasmCapabilityGrant = applyWasmCapabilityGrant as jest.MockedFunction<
    typeof applyWasmCapabilityGrant
  >
  const mockClearWasmCapabilityGrant = clearWasmCapabilityGrant as jest.MockedFunction<
    typeof clearWasmCapabilityGrant
  >
  const mockReconcileWasmGrantLedgerWithManifest =
    reconcileWasmGrantLedgerWithManifest as jest.MockedFunction<
      typeof reconcileWasmGrantLedgerWithManifest
    >

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
    mockTransportCall.mockReset()
    mockTransportSubscribe.mockReset()
    delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
    mockGetState.mockReset()
    mockVerifier.verify.mockReset()
    mockVerifier.verify.mockResolvedValue({ valid: true })
    mockGuard.registerPlugin.mockReset()
    mockGuard.unregisterPlugin.mockReset()
    mockGuard.revokeAll.mockReset()
    mockGuard.getTier.mockReset()
    mockGuard.getTier.mockReturnValue("silent")
    mockGetSlashCommand.mockReset()
    mockGetSlashCommand.mockReturnValue(undefined)
    mockRegisterSlashCommand.mockReset()
    mockUnregisterSlashCommand.mockReset()
    mockCanUseTauriInvoke.mockReset()
    mockCanUseTauriInvoke.mockReturnValue(true)
    mockApplyWasmCapabilityGrant.mockClear()
    mockClearWasmCapabilityGrant.mockClear()
    mockReconcileWasmGrantLedgerWithManifest.mockClear()
    ;(getPluginConsentBroker().clearSessionGrantsForPlugin as jest.Mock).mockClear()
    ;(getPluginSignatureVerifier as jest.Mock).mockReturnValue(mockVerifier)
    ;(getPermissionGuard as jest.Mock).mockReturnValue(mockGuard)
    clearPluginExtensions("rollback-plugin")
  })

  describe("syncBackendStatus", () => {
    type WithSync = { syncBackendStatus: (id: string, status: string) => Promise<void> }

    it("dispatches the plugin_set_status status-ledger command (not plugin_set_state)", async () => {
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      mockInvoke.mockResolvedValue(undefined)
      await (manager as unknown as WithSync).syncBackendStatus("p1", "enabled")
      expect(mockInvoke).toHaveBeenCalledWith("plugin_set_status", {
        pluginId: "p1",
        status: "enabled",
      })
      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_set_state", expect.anything())
    })

    it("does not throw when the backend invoke rejects (records a silent failure)", async () => {
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      mockInvoke.mockRejectedValue(new Error("backend down"))
      await expect(
        (manager as unknown as WithSync).syncBackendStatus("p1", "disabled")
      ).resolves.toBeUndefined()
    })
  })

  describe("installPluginFromGithub", () => {
    it("invokes plugin_install_from_github, registers via the shared tail, and returns the installed plugin", async () => {
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
            store.plugins[pluginId] = { ...p, status: "installed", installedAt: new Date() }
          }
        }),
      }
      mockGetState.mockReturnValue(store)

      const manifest = createManifest("gh-plugin")
      mockInvoke.mockResolvedValueOnce({
        manifest,
        path: "/plugins/gh-plugin",
        source: "git",
        installRootKind: "installed",
        readme: "# Demo",
        licenseText: "MIT",
        repo: "acme/gh",
        gitRef: "main",
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const plugin = await manager.installPluginFromGithub("acme/gh", "main", "sub")

      expect(mockInvoke).toHaveBeenCalledWith("plugin_install_from_github", {
        repo: "acme/gh",
        gitRef: "main",
        subdir: "sub",
      })
      expect(store.discoverPlugin).toHaveBeenCalledWith(
        manifest,
        "git",
        "/plugins/gh-plugin",
        expect.objectContaining({
          descriptor: expect.objectContaining({ source: "git" }),
        })
      )
      expect(store.installPlugin).toHaveBeenCalledWith("gh-plugin")
      expect(plugin?.manifest.id).toBe("gh-plugin")
      expect(plugin?.status).toBe("installed")
    })

    it("wraps a backend failure in a 'Failed to install plugin' error", async () => {
      const store = {
        plugins: {},
        discoverPlugin: jest.fn(),
        installPlugin: jest.fn(async () => undefined),
      }
      mockGetState.mockReturnValue(store)
      mockInvoke.mockRejectedValueOnce(new Error("tarball 404"))

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await expect(manager.installPluginFromGithub("acme/missing")).rejects.toThrow(
        /Failed to install plugin/i
      )
    })

    it("mirrors silent declared permissions to the Rust ledger, skipping confirm-tier ones", async () => {
      // clipboard:read is silent → mirrored; filesystem:write is confirm → not.
      mockGuard.getTier.mockImplementation((_id: string, perm: string) =>
        perm === "filesystem:write" ? "confirm" : "silent"
      )
      mockInvoke.mockResolvedValue(undefined)
      mockCanUseTauriInvoke.mockReturnValue(true)

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await (
        manager as unknown as {
          mirrorDeclaredPermissionsToLedger: (id: string, perms: string[]) => Promise<void>
        }
      ).mirrorDeclaredPermissionsToLedger("perm-plugin", ["clipboard:read", "filesystem:write"])

      expect(mockInvoke).toHaveBeenCalledWith("plugin_permission_grant", {
        pluginId: "perm-plugin",
        permission: "clipboard:read",
        grantedBy: "manifest",
        expiresAt: null,
      })
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "plugin_permission_grant",
        expect.objectContaining({ permission: "filesystem:write" })
      )
    })

    it("does not mirror to the ledger in web mode (no Tauri invoke)", async () => {
      mockCanUseTauriInvoke.mockReturnValue(false)
      mockInvoke.mockResolvedValue(undefined)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await (
        manager as unknown as {
          mirrorDeclaredPermissionsToLedger: (id: string, perms: string[]) => Promise<void>
        }
      ).mirrorDeclaredPermissionsToLedger("perm-plugin", ["clipboard:read"])
      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_permission_grant", expect.anything())
    })

    it("pushes the declared shell-command allowlist to the host on desktop", async () => {
      mockInvoke.mockResolvedValue(undefined)
      mockCanUseTauriInvoke.mockReturnValue(true)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await (
        manager as unknown as {
          syncShellAllowlistToHost: (id: string, commands: string[]) => Promise<void>
        }
      ).syncShellAllowlistToHost("sh-plugin", ["git", "node"])
      expect(mockInvoke).toHaveBeenCalledWith("plugin_set_shell_allowlist", {
        pluginId: "sh-plugin",
        commands: ["git", "node"],
      })
    })

    it("does not push the shell allowlist in web mode (no Tauri invoke)", async () => {
      mockCanUseTauriInvoke.mockReturnValue(false)
      mockInvoke.mockResolvedValue(undefined)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await (
        manager as unknown as {
          syncShellAllowlistToHost: (id: string, commands: string[]) => Promise<void>
        }
      ).syncShellAllowlistToHost("sh-plugin", ["git"])
      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_set_shell_allowlist", expect.anything())
    })

    it("pushes the declared network egress allowlist to the host on desktop", async () => {
      mockInvoke.mockResolvedValue(undefined)
      mockCanUseTauriInvoke.mockReturnValue(true)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await (
        manager as unknown as {
          syncNetworkAllowlistToHost: (id: string, domains: string[]) => Promise<void>
        }
      ).syncNetworkAllowlistToHost("net-plugin", ["api.example.com", "*.cdn.test"])
      expect(mockInvoke).toHaveBeenCalledWith("plugin_set_network_allowlist", {
        pluginId: "net-plugin",
        domains: ["api.example.com", "*.cdn.test"],
      })
    })
  })

  describe("registerDiskPlugin", () => {
    it("discovers + installs a disk plugin into the store as a local source", async () => {
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
          if (p) store.plugins[pluginId] = { ...p, status: "installed", installedAt: new Date() }
        }),
      }
      mockGetState.mockReturnValue(store)

      const manifest = createManifest("disk-plugin")
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await manager.registerDiskPlugin(manifest, "/home/u/.cognia/plugins/disk-plugin")

      expect(store.discoverPlugin).toHaveBeenCalledWith(
        manifest,
        "local",
        "/home/u/.cognia/plugins/disk-plugin",
        expect.objectContaining({ descriptor: expect.objectContaining({ source: "local" }) })
      )
      expect(store.installPlugin).toHaveBeenCalledWith("disk-plugin")
    })

    it("does not re-install an already-known plugin (idempotent refresh)", async () => {
      const manifest = createManifest("known-plugin")
      const store = {
        plugins: {
          "known-plugin": { manifest, status: "enabled", source: "local", path: "/d", config: {} },
        },
        discoverPlugin: jest.fn(),
        installPlugin: jest.fn(async () => undefined),
      }
      mockGetState.mockReturnValue(store)

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await manager.registerDiskPlugin(manifest, "/d")

      expect(store.discoverPlugin).toHaveBeenCalled()
      expect(store.installPlugin).not.toHaveBeenCalled()
    })

    it("throws on an invalid manifest", async () => {
      mockGetState.mockReturnValue({
        plugins: {},
        discoverPlugin: jest.fn(),
        installPlugin: jest.fn(),
      })
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      // Missing required fields → validation fails.
      await expect(
        manager.registerDiskPlugin({ id: "", name: "" } as unknown as PluginManifest, "/d")
      ).rejects.toThrow(/Invalid plugin manifest/i)
    })
  })

  describe("scanBrowserBuiltins persistence", () => {
    it("persists every discovered built-in to the Dexie plugins table with source 'builtin'", async () => {
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
          if (p) store.plugins[pluginId] = { ...p, status: "installed", installedAt: new Date() }
        }),
      }
      mockGetState.mockReturnValue(store)
      ;(upsertPlugin as jest.Mock).mockClear()

      const manager = new PluginManager({
        pluginDirectory: "/plugins",
        runtimeProfile: "browser",
      })
      const discovered = await manager.scanPlugins()

      // Every built-in surfaced by the registry walk must land in Dexie, or the
      // Dexie-backed Library + marketplace "Built-in" section render nothing.
      expect(discovered.length).toBeGreaterThan(0)
      expect(upsertPlugin).toHaveBeenCalledTimes(discovered.length)
      expect(upsertPlugin).toHaveBeenCalledWith(
        expect.objectContaining({ source: "builtin", type: expect.any(String) })
      )
    })

    it("swallows a Dexie persistence failure so discovery still completes", async () => {
      const store = {
        plugins: {} as Record<string, Plugin>,
        discoverPlugin: jest.fn(),
        installPlugin: jest.fn(async () => undefined),
      }
      mockGetState.mockReturnValue(store)
      ;(upsertPlugin as jest.Mock).mockClear()
      ;(upsertPlugin as jest.Mock).mockRejectedValue(new Error("IndexedDB closed"))

      const manager = new PluginManager({
        pluginDirectory: "/plugins",
        runtimeProfile: "browser",
      })
      const discovered = await manager.scanPlugins()

      // A persistence hiccup must not abort the in-memory discovery walk.
      expect(discovered.length).toBeGreaterThan(0)
      expect(upsertPlugin).toHaveBeenCalled()
      ;(upsertPlugin as jest.Mock).mockResolvedValue(undefined)
    })
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
      expect(mockApplyWasmCapabilityGrant).toHaveBeenCalledWith({
        pluginId: "demo.wasm",
        grantedPermissions: ["notification"],
        grantedPreopens: [],
      })
      expect(mockReconcileWasmGrantLedgerWithManifest).toHaveBeenCalledWith("demo.wasm", [])

      await manager.uninstallPlugin("demo.wasm")

      expect(mockClearWasmCapabilityGrant).toHaveBeenCalledWith("demo.wasm")
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

  describe("installPlugin rollback (PR1)", () => {
    // Helpers — build a fresh store mock that records which lifecycle calls
    // landed so the rollback assertions can check we walked the right tape.
    function makeStore() {
      const store: {
        plugins: Record<string, Plugin>
        discoverPlugin: jest.Mock
        installPlugin: jest.Mock
        uninstallPlugin: jest.Mock
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
      }
      return store
    }

    it("rolls back backend install + store row when signature verification fails", async () => {
      const store = makeStore()
      mockGetState.mockReturnValue(store)
      // Configure verifier to demand signatures + reject this plugin.
      mockVerifier.getConfig.mockReturnValueOnce({
        requireSignatures: true,
        allowUntrusted: false,
      })
      mockVerifier.verify.mockResolvedValueOnce({ valid: false, reason: "bad sig" })

      const manifest = createManifest("sig-fail-plugin")
      mockInvoke
        // 1st invoke: plugin_install (backend succeeds)
        .mockResolvedValueOnce({
          manifest,
          path: "/plugins/sig-fail-plugin",
        })
        // 2nd invoke (during rollback): plugin_uninstall
        .mockResolvedValueOnce(undefined)

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await expect(manager.installPlugin("/tmp/sig-fail")).rejects.toThrow(
        /Failed to install plugin/i
      )

      // Backend install was undone via plugin_uninstall.
      expect(mockInvoke).toHaveBeenCalledWith("plugin_uninstall", {
        pluginId: "sig-fail-plugin",
        pluginPath: "/plugins/sig-fail-plugin",
      })
      // Store discovery + install never landed (signature check is before
      // those), so no store cleanup expected.
      expect(store.discoverPlugin).not.toHaveBeenCalled()
      expect(store.installPlugin).not.toHaveBeenCalled()
      expect(store.uninstallPlugin).not.toHaveBeenCalled()
    })

    it("rolls back store row + backend install when permission registration throws", async () => {
      const store = makeStore()
      mockGetState.mockReturnValue(store)
      const manifest = {
        ...createManifest("perm-fail-plugin"),
        permissions: ["filesystem:read"],
      }
      mockInvoke
        .mockResolvedValueOnce({ manifest, path: "/plugins/perm-fail" })
        .mockResolvedValueOnce(undefined) // plugin_uninstall during rollback

      // registerPlugin on the permission guard throws — exercises the
      // try/catch that promotes silent permission-registration failures
      // to a rollback-worthy error.
      mockGuard.registerPlugin.mockImplementationOnce(() => {
        throw new Error("dexie write blew up")
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await expect(manager.installPlugin("/tmp/perm-fail")).rejects.toThrow(
        /Permission registration failed/i
      )

      // Store row was cleaned up.
      expect(store.uninstallPlugin).toHaveBeenCalledWith(
        "perm-fail-plugin",
        expect.objectContaining({ skipFileRemoval: true })
      )
      // Backend uninstall ran.
      expect(mockInvoke).toHaveBeenCalledWith("plugin_uninstall", {
        pluginId: "perm-fail-plugin",
        pluginPath: "/plugins/perm-fail",
      })
    })

    it("does not call plugin_uninstall when backend install itself never succeeded", async () => {
      const store = makeStore()
      mockGetState.mockReturnValue(store)
      mockInvoke.mockRejectedValueOnce(new Error("disk full"))

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await expect(manager.installPlugin("/tmp/never")).rejects.toThrow(/Failed to install/i)

      // The only invoke call was the failed plugin_install — no rollback
      // call should have followed.
      const uninstallCalls = mockInvoke.mock.calls.filter((call) => call[0] === "plugin_uninstall")
      expect(uninstallCalls).toHaveLength(0)
      expect(store.discoverPlugin).not.toHaveBeenCalled()
    })

    it("rollback step failures do not prevent the install error from surfacing", async () => {
      const store = makeStore()
      mockGetState.mockReturnValue(store)
      mockVerifier.getConfig.mockReturnValueOnce({
        requireSignatures: true,
        allowUntrusted: false,
      })
      mockVerifier.verify.mockResolvedValueOnce({ valid: false, reason: "bad sig" })

      const manifest = createManifest("noisy-rollback-plugin")
      mockInvoke
        .mockResolvedValueOnce({ manifest, path: "/plugins/noisy" })
        // Backend plugin_uninstall ALSO fails — we still expect the
        // original install error to reach the caller.
        .mockRejectedValueOnce(new Error("disk locked"))

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await expect(manager.installPlugin("/tmp/noisy")).rejects.toThrow(/Failed to install plugin/i)
    })

    it("public rollbackInstallation cleans an already-installed plugin row", async () => {
      const store = makeStore()
      // Pretend an earlier install already left a row in place.
      const manifest = createManifest("public-rollback")
      store.plugins["public-rollback"] = {
        manifest,
        status: "installed",
        source: "local" as never,
        path: "/plugins/public-rollback",
        config: {},
        installedAt: new Date(),
      }
      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValueOnce(undefined) // plugin_uninstall

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await manager.rollbackInstallation("public-rollback", "config persist failed")

      expect(store.uninstallPlugin).toHaveBeenCalledWith(
        "public-rollback",
        expect.objectContaining({ skipFileRemoval: true })
      )
      expect(mockInvoke).toHaveBeenCalledWith("plugin_uninstall", {
        pluginId: "public-rollback",
        pluginPath: "/plugins/public-rollback",
      })
    })

    it("public rollbackInstallation is a no-op when the plugin row no longer exists", async () => {
      const store = makeStore()
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await manager.rollbackInstallation("ghost-plugin", "config persist failed")
      expect(store.uninstallPlugin).not.toHaveBeenCalled()
      expect(mockInvoke).not.toHaveBeenCalled()
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

    it("every scanned browser builtin declares a valid browser runtime availability", async () => {
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

      // Every plugin in the browser builtin registry must DECLARE its browser
      // runtime compatibility with a valid availability value. An explicit
      // `blocked` (e.g. cognia-sandboxed-tools, desktop-only by design) is
      // fine — what must never recur is a missing block (workspace-tools /
      // web-tools) or an out-of-enum value (workflow-ai's "available",
      // screenshot's "partial"), both of which silently blocked the plugin
      // in browser mode before the manifest conformance sweep.
      expect(store.discoverPlugin).toHaveBeenCalled()
      for (const call of store.discoverPlugin.mock.calls) {
        const [manifest] = call as [PluginManifest]
        const browser = manifest.runtimeCompatibility?.browser
        expect(`${manifest.id}: ${browser?.availability}`).toMatch(
          new RegExp(`^${manifest.id}: (supported|degraded|blocked)$`)
        )
      }
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
      // Built-ins discovered by the same scan may install themselves; the
      // assertion under test is that the *existing* plugin isn't reinstalled.
      expect(store.installPlugin).not.toHaveBeenCalledWith("source-shift-plugin")
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

      // Built-ins are still discovered on the tauri profile; the invalid
      // directory entry itself must be skipped.
      const discoveredIds = (store.discoverPlugin as jest.Mock).mock.calls.map(
        (c) => (c[0] as PluginManifest).id
      )
      expect(discoveredIds).not.toContain("invalid-plugin")
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

      // `processors` is still an `experimental` capability in the host
      // contract, so it emits a `plugin.capability.experimental` warning.
      // (The previously-used `themes` capability was promoted
      // partial→supported and no longer produces a diagnostic.)
      const manifest: PluginManifest = {
        ...createManifest("processors-plugin"),
        capabilities: ["processors"],
      }

      mockInvoke.mockResolvedValueOnce([
        {
          manifest,
          path: "/plugins/processors-plugin",
        },
      ])

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      await manager.scanPlugins()

      expect(store.discoverPlugin).toHaveBeenCalledWith(
        manifest,
        "local",
        "/plugins/processors-plugin",
        expect.objectContaining({
          compatibilityDiagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: "manifest.capabilities.plugin.capability.experimental",
              severity: "warning",
            }),
          ]),
          descriptor: expect.objectContaining({
            compatibility: expect.objectContaining({
              diagnostics: expect.arrayContaining([
                expect.objectContaining({
                  code: "manifest.capabilities.plugin.capability.experimental",
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
    it("passes a lazy active-database provider to startup schema restoration", async () => {
      const { restorePluginTables } = jest.requireMock("@/lib/plugin/dexie/bridge") as {
        restorePluginTables: jest.Mock
      }
      restorePluginTables.mockClear().mockResolvedValueOnce([])
      mockGetState.mockReturnValue({
        plugins: {
          "db-plugin": {
            manifest: {
              ...createManifest("db-plugin"),
              dexie: { tables: [{ name: "items", schema: "++id" }] },
            },
            status: "installed",
            source: "builtin",
            config: {},
          },
        },
      })
      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "browser" })

      await (
        manager as unknown as { restorePluginDexieTables: () => Promise<void> }
      ).restorePluginDexieTables()

      expect(restorePluginTables.mock.calls[0][0]).toEqual(expect.any(Function))
    })

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

      // Regression guard for the dormant-messaging activation: a plugin
      // subscribed to the global bus must actually receive the host's
      // lifecycle events, and the IPC manager must learn about the plugin.
      resetMessageBus()
      resetPluginIPC()
      const enabledEvents: string[] = []
      getMessageBus().on(SystemEvents.PLUGIN_ENABLED, (event) => {
        enabledEvents.push((event.payload as { pluginId: string }).pluginId)
      })

      await manager.enablePlugin("cognia-clipboard-tools")

      expect(store.registerPluginTool).toHaveBeenCalledWith(
        "cognia-clipboard-tools",
        expect.objectContaining({ name: "clipboard_status" })
      )
      expect(manager.getRegistry().getTool("clipboard_status")).toBeDefined()
      expect(store.plugins["cognia-clipboard-tools"].status).toBe("enabled")
      // Host emitted PLUGIN_ENABLED on the bus, and load registered the plugin
      // with the IPC manager (so its exposed-method registry exists).
      expect(enabledEvents).toContain("cognia-clipboard-tools")
      expect(getPluginIPC().getAllExposedMethods().has("cognia-clipboard-tools")).toBe(true)
    })

    it("recovers a plugin stuck in error status instead of dead-ending on the status guard", async () => {
      // Regression: a plugin left in `status: "error"` dead-ends every
      // activation retry on the store guards ("cannot be enabled from status:
      // error"), so the failure re-dispatches on every activation event and the
      // activation breaker can never observe a real recovery. enablePlugin must
      // heal the errored plugin back to a loadable resting state and re-run
      // load + activate.
      Object.defineProperty(global.navigator, "clipboard", {
        configurable: true,
        value: {
          readText: jest.fn().mockResolvedValue("browser clipboard"),
          writeText: jest.fn().mockResolvedValue(undefined),
        },
      })

      const store = {
        plugins: {} as Record<string, Plugin>,
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
          store.plugins[pluginId] = {
            ...store.plugins[pluginId],
            status: "installed",
            installedAt: new Date(),
          }
        }),
        loadPlugin: jest.fn(async (pluginId: string) => {
          store.plugins[pluginId] = { ...store.plugins[pluginId], status: "loaded" }
        }),
        enablePlugin: jest.fn(async (pluginId: string) => {
          store.plugins[pluginId] = { ...store.plugins[pluginId], status: "enabled" }
        }),
        registerPluginHooks: jest.fn(),
        registerPluginTool: jest.fn(),
        registerPluginCommand: jest.fn(),
        setPluginStatus: jest.fn((pluginId: string, status: Plugin["status"]) => {
          store.plugins[pluginId] = { ...store.plugins[pluginId], status }
        }),
        setPluginError: jest.fn((pluginId: string, error: string | null) => {
          store.plugins[pluginId] = {
            ...store.plugins[pluginId],
            error: error ?? undefined,
            ...(error === null ? {} : { status: "error" as const }),
          }
        }),
        setPluginVerificationSnapshot: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValue(undefined)

      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "browser" })
      await manager.scanPlugins()

      // First enable succeeds and leaves the runtime loaded.
      await manager.enablePlugin("cognia-clipboard-tools")
      expect(store.plugins["cognia-clipboard-tools"].status).toBe("enabled")

      // Simulate the plugin having been driven into the dead-end error status
      // (as a failed activation would leave it).
      store.setPluginError("cognia-clipboard-tools", "boom")
      expect(store.plugins["cognia-clipboard-tools"].status).toBe("error")

      // The retry must heal it — clear the error, reset to a loadable resting
      // state, and re-run load + activate — rather than throw the guard error.
      await expect(manager.enablePlugin("cognia-clipboard-tools")).resolves.not.toThrow()

      expect(store.setPluginError).toHaveBeenCalledWith("cognia-clipboard-tools", null)
      expect(store.setPluginStatus).toHaveBeenCalledWith("cognia-clipboard-tools", "installed")
      expect(store.plugins["cognia-clipboard-tools"].status).toBe("enabled")
    })

    it("enables a builtin plugin without signature verification even when signatures are required", async () => {
      // Built-ins are statically bundled into the renderer (path
      // `builtin://<id>`, no on-disk signature.json) and trusted by
      // construction. With the default-on `requireSignatures` policy, the
      // verifier would reject them ("Signature required but not found"), so
      // the enable path must exempt `source === "builtin"` — mirroring the
      // scan path, which never verifies built-ins.
      Object.defineProperty(global.navigator, "clipboard", {
        configurable: true,
        value: {
          readText: jest.fn().mockResolvedValue("browser clipboard"),
          writeText: jest.fn().mockResolvedValue(undefined),
        },
      })

      // Real-world policy: signatures required, untrusted signers rejected.
      mockVerifier.getConfig.mockReturnValue({
        requireSignatures: true,
        allowUntrusted: false,
      })
      // A built-in has no signature file, so verify would fail if called.
      mockVerifier.verify.mockResolvedValue({
        valid: false,
        reason: "Signature required but not found",
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
          store.plugins[pluginId] = { ...plugin, status: "installed", installedAt: new Date() }
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
            store.plugins[pluginId] = { ...plugin, tools: [...(plugin.tools || []), tool] }
          }
        ),
        registerPluginCommand: jest.fn(),
        setPluginError: jest.fn(),
        setPluginVerificationSnapshot: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValue(undefined)

      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "browser" })
      await manager.scanPlugins()

      await expect(manager.enablePlugin("cognia-clipboard-tools")).resolves.not.toThrow()

      expect(store.plugins["cognia-clipboard-tools"].status).toBe("enabled")
      // The signature verifier must never be consulted for a built-in.
      expect(mockVerifier.verify).not.toHaveBeenCalled()
    })

    it("applies a plugin's declared Dexie tables BEFORE loadPlugin runs activate()", async () => {
      // Regression: loadPlugin runs the plugin's activate(), and activate()
      // typically touches ctx.dexie right away (github-delivery counts its 4
      // tables). If applyPluginTables runs AFTER loadPlugin, that first
      // db.table() throws "Table <id>:<name> does not exist" on a first-ever
      // enable (no persisted pluginDexieMeta row to restore at boot), and the
      // meta row is never written — so the plugin can never be enabled on any
      // later boot either. applyPluginTables MUST precede loadPlugin.
      const { applyPluginTables } = jest.requireMock("@/lib/plugin/dexie/bridge") as {
        applyPluginTables: jest.Mock
      }
      applyPluginTables.mockClear()

      const store = {
        plugins: {} as Record<string, Plugin>,
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
          store.plugins[pluginId] = {
            ...store.plugins[pluginId],
            status: "installed",
            installedAt: new Date(),
          }
        }),
        loadPlugin: jest.fn(),
        enablePlugin: jest.fn(async (pluginId: string) => {
          store.plugins[pluginId] = { ...store.plugins[pluginId], status: "enabled" }
        }),
        registerPluginHooks: jest.fn(),
        registerPluginTool: jest.fn(),
        registerPluginCommand: jest.fn(),
        setPluginError: jest.fn(),
        setPluginVerificationSnapshot: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValue(undefined)

      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "browser" })
      await manager.scanPlugins()

      // github-delivery declares a `dexie` block in its manifest, so
      // applyPluginTables must fire. Stub the manager's loadPlugin (which is
      // what actually runs activate()) so we can observe invocation order
      // without a real IndexedDB / module load.
      const loadSpy = jest.spyOn(manager, "loadPlugin").mockResolvedValue(undefined)

      await manager.enablePlugin("github-delivery")

      expect(applyPluginTables).toHaveBeenCalledTimes(1)
      expect(applyPluginTables.mock.calls[0][0]).toEqual(expect.any(Function))
      expect(loadSpy).toHaveBeenCalledTimes(1)
      expect(applyPluginTables.mock.invocationCallOrder[0]).toBeLessThan(
        loadSpy.mock.invocationCallOrder[0]
      )
    })

    it("registers a WASM plugin's declared tools so the agent can call them", async () => {
      const wasmManifest: PluginManifest = {
        id: "demo.wasm.tools",
        name: "Demo WASM Tools",
        version: "0.1.0",
        description: "x",
        type: "wasm",
        capabilities: ["tools"],
        wasmMain: "main.wasm",
        wasm: { apiVersion: "0.1.0" },
        permissions: ["notification"],
        tools: [
          { name: "do_thing", description: "Does a thing", parametersSchema: { type: "object" } },
        ],
      }

      const store = {
        plugins: {
          "demo.wasm.tools": {
            manifest: wasmManifest,
            status: "installed",
            source: "local",
            path: "/plugins/demo.wasm.tools",
            config: {},
          },
        } as Record<string, Plugin>,
        loadPlugin: jest.fn(async (pluginId: string) => {
          store.plugins[pluginId] = { ...store.plugins[pluginId], status: "loaded" }
        }),
        enablePlugin: jest.fn(async (pluginId: string) => {
          store.plugins[pluginId] = { ...store.plugins[pluginId], status: "enabled" }
        }),
        registerPluginHooks: jest.fn(),
        registerPluginTool: jest.fn(
          (pluginId: string, tool: NonNullable<Plugin["tools"]>[number]) => {
            const plugin = store.plugins[pluginId]
            store.plugins[pluginId] = { ...plugin, tools: [...(plugin.tools || []), tool] }
          }
        ),
        registerPluginCommand: jest.fn(),
        setPluginError: jest.fn(),
        setPluginVerificationSnapshot: jest.fn(),
        setPluginStatus: jest.fn(),
      }

      mockGetState.mockReturnValue(store)
      mockInvoke.mockResolvedValue(undefined)
      resetMessageBus()
      resetPluginIPC()

      // Default "tauri" profile so the wasm plugin passes the runtime gate; the
      // loader still returns a stub definition in jsdom (no wasm host), but the
      // manifest-tool bridge runs regardless of the host being live.
      const manager = new PluginManager({ pluginDirectory: "" })
      const loadSpy = jest.spyOn(
        (
          manager as unknown as {
            loader: { load(plugin: Plugin): Promise<unknown> }
          }
        ).loader,
        "load"
      )
      await manager.enablePlugin("demo.wasm.tools")

      const grantCallIndex = mockInvoke.mock.calls.findIndex(
        ([command]) => command === "plugin_permission_grant"
      )
      expect(grantCallIndex).toBeGreaterThanOrEqual(0)
      expect(mockInvoke.mock.invocationCallOrder[grantCallIndex]).toBeLessThan(
        loadSpy.mock.invocationCallOrder[0]
      )

      // The declared tool is registered under the namespaced name and is
      // resolvable from the registry — proving the manifest → tool-execute
      // bridge runs at enable time.
      expect(store.registerPluginTool).toHaveBeenCalledWith(
        "demo.wasm.tools",
        expect.objectContaining({ name: "demo.wasm.tools:do_thing" })
      )
      expect(manager.getRegistry().getTool("demo.wasm.tools:do_thing")).toBeDefined()
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
      const { removePluginTables } = jest.requireMock("@/lib/plugin/dexie/bridge") as {
        removePluginTables: jest.Mock
      }
      removePluginTables.mockClear()
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
      expect(removePluginTables.mock.calls[0][0]).toEqual(expect.any(Function))
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
      // Seed the live context the way `activate` would, so the teardown
      // assertion below exercises the real forwarding path.
      ;(manager as unknown as { contexts: Map<string, unknown> }).contexts.set("to-disable", {
        pluginId: "to-disable",
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
      // The plugin's own context MUST be forwarded: `deactivate(ctx?)` is how a
      // plugin releases resources the host cannot reclaim (a `setInterval`
      // clipboard poller, imperatively-registered slash commands), and every
      // first-party implementation guards on `if (ctx?.pluginId)`. Calling it
      // bare made all of those guards fail closed and the resources outlived
      // disable — a clipboard read loop surviving a revoked `clipboard:read`.
      expect(deactivate).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "to-disable" }))
      expect(mockGuard.revokeAll).toHaveBeenCalledWith("to-disable")
      // Disabling a plugin must drop its "always allow this session" consent
      // grants so a dangerous-permission grant can't silently outlive disable.
      expect(getPluginConsentBroker().clearSessionGrantsForPlugin).toHaveBeenCalledWith(
        "to-disable"
      )
      expect(contextPanelRegistry.unregisterPlugin).toHaveBeenCalledWith("to-disable")
    })

    it("clears the plugin's IPC + event-bus subscriptions on disable", async () => {
      // Regression: disabling a plugin tore down hooks/contributions but left
      // its inter-plugin IPC subscriptions / exposed methods and event-bus
      // listeners registered on the global singletons, so a disabled plugin
      // kept receiving traffic and a re-enable duplicated subscriptions.
      resetPluginIPC()
      resetMessageBus()

      const store = {
        plugins: {
          "msg-leak": {
            manifest: createManifest("msg-leak"),
            status: "enabled",
            source: "local",
            path: "/plugins/msg-leak",
            config: {},
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

      // Seed live messaging state the plugin would have created via ctx.ipc /
      // ctx.events at runtime.
      const ipc = getPluginIPC()
      ipc.registerPlugin("msg-leak", [])
      ipc.subscribe("msg-leak", "demo-channel", () => {})
      ipc.expose("msg-leak", { ping: () => "pong" })
      getMessageBus().on("demo:event", () => {}, { source: { type: "plugin", id: "msg-leak" } })

      expect(ipc.getExposedMethods("msg-leak")).toContain("ping")
      expect(getMessageBus().getSubscriptionsBySource("msg-leak")).toContain("demo:event")

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await manager.disablePlugin("msg-leak")

      expect(ipc.getExposedMethods("msg-leak")).toHaveLength(0)
      expect(ipc.getSubscriptions("msg-leak").size).toBe(0)
      expect(getMessageBus().getSubscriptionsBySource("msg-leak")).toHaveLength(0)
    })

    it("continues teardown when deactivate() throws (swallow-and-record, W6.2)", async () => {
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

      // W6.2: a throwing deactivate() is swallowed-and-recorded — the
      // teardown continues and the disable SUCCEEDS, so the plugin can't
      // leak permissions/IPC/WASM grants by throwing on the way out.
      await expect(manager.disablePlugin("disable-failure")).resolves.toBeUndefined()

      expect(deactivate).toHaveBeenCalledTimes(1)
      expect(store.disablePlugin).toHaveBeenCalledWith("disable-failure", { viaManager: false })
      // The failure is not surfaced as a plugin ERROR state — the success
      // path clears the error field (null); it lands in the silent-failure
      // diagnostics instead.
      expect(store.setPluginError).toHaveBeenCalledWith("disable-failure", null)
      expect(store.setPluginError).not.toHaveBeenCalledWith(
        "disable-failure",
        expect.stringMatching(/deactivate failed/)
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
    // Fixtures use source "dev" (inherently trusted): these frontend-type
    // plugins would otherwise be skipped by the frontend trust boundary
    // before reaching the event-matching behavior under test.
    it("should activate plugin when command activation event matches", async () => {
      const pluginA: Plugin = {
        manifest: {
          ...createManifest("event-plugin"),
          activationEvents: ["onCommand:test-command"],
        },
        status: "installed",
        source: "dev",
        path: "/plugins/event-plugin",
        config: {},
      }
      const pluginB: Plugin = {
        manifest: {
          ...createManifest("other-plugin"),
          activationEvents: ["onCommand:other-command"],
        },
        status: "installed",
        source: "dev",
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
        source: "dev",
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
        source: "dev",
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
        source: "dev",
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
        source: "dev",
        path: "/plugins/view-plugin",
        config: {},
      }
      const wildcardView: Plugin = {
        manifest: {
          ...createManifest("inbox-view-plugin"),
          activationEvents: ["onView:inbox.*"],
        },
        status: "installed",
        source: "dev",
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
        source: "dev",
        path: "/plugins/cmd-only-plugin",
        config: {},
      }
      mockGetState.mockReturnValue({ plugins: { "cmd-only-plugin": cmdPlugin } })
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("onView:settings.plugins")
      expect(enableSpy).not.toHaveBeenCalled()
    })

    it("surfaces an activation failure (no silent swallow) and opens the breaker", async () => {
      __resetRegistryForTesting()
      __resetResilienceTelemetryForTesting()
      const setPluginError = jest.fn()
      const failPlugin: Plugin = {
        manifest: {
          ...createManifest("fail-activate"),
          activationEvents: ["onTool:boom"],
        },
        status: "installed",
        source: "dev",
        path: "/plugins/fail-activate",
        config: {},
      }
      mockGetState.mockReturnValue({
        plugins: { "fail-activate": failPlugin },
        setPluginError,
      })
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const enableSpy = jest
        .spyOn(manager, "enablePlugin")
        .mockRejectedValue(new Error("activate exploded"))

      // LOAD_RESILIENCE.breaker.failureThreshold === 3: three failed activations
      // trip the breaker; the fourth event is suppressed without re-attempting.
      for (let i = 0; i < 3; i++) {
        await manager.handleActivationEvent("onTool:boom")
      }
      expect(enableSpy).toHaveBeenCalledTimes(3)
      // Failure surfaced: per-plugin error set + telemetry recorded.
      expect(setPluginError).toHaveBeenCalledWith("fail-activate", "activate exploded")
      expect(
        getRecentActivationFailures().filter((r) => r.pluginId === "fail-activate").length
      ).toBe(3)

      // Breaker now open → suppressed, enablePlugin not called again.
      await manager.handleActivationEvent("onTool:boom")
      expect(enableSpy).toHaveBeenCalledTimes(3)

      __resetRegistryForTesting()
      __resetResilienceTelemetryForTesting()
    })

    it("does not lazy-activate a plugin the browser runtime profile blocks", async () => {
      // The Capacitor mobile shell (and dev web) boots the plugin manager in
      // the `browser` profile. A desktop-native builtin (browser.availability
      // === "blocked") must NOT auto-activate on startup — doing so throws in
      // loadPlugin and spams an activation-failure toast per plugin.
      const nativeOnly: Plugin = {
        manifest: {
          ...createManifest("cognia-native-only"),
          activationEvents: ["startup"],
          runtimeCompatibility: {
            browser: { availability: "blocked", reason: "Requires native desktop APIs" },
          },
        },
        status: "installed",
        source: "builtin",
        path: "builtin://cognia-native-only",
        config: {},
      }
      mockGetState.mockReturnValue({ plugins: { "cognia-native-only": nativeOnly } })

      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "browser" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("startup")

      expect(enableSpy).not.toHaveBeenCalled()
    })

    it("still activates a browser-blocked plugin on the tauri profile (desktop unaffected)", async () => {
      // Runtime-profile gating is browser-only; on desktop the same builtin
      // must continue to auto-activate exactly as before.
      const nativeOnly: Plugin = {
        manifest: {
          ...createManifest("cognia-native-only"),
          activationEvents: ["startup"],
          runtimeCompatibility: {
            browser: { availability: "blocked", reason: "Requires native desktop APIs" },
          },
        },
        status: "installed",
        source: "builtin",
        path: "builtin://cognia-native-only",
        config: {},
      }
      mockGetState.mockReturnValue({ plugins: { "cognia-native-only": nativeOnly } })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("startup")

      expect(enableSpy).toHaveBeenCalledWith("cognia-native-only", "activation:startup")
    })
  })

  describe("restorePluginStates runtime-profile gating", () => {
    it("auto-enables runtime-compatible builtins but skips browser-blocked ones", async () => {
      // Reproduces the mobile/web boot flood: a mix of startup builtins where
      // only the browser-supported one should be auto-enabled. The blocked one
      // stays discovered (visible in /plugins) but is never auto-enabled.
      const supported: Plugin = {
        manifest: {
          ...createManifest("cognia-web-tools"),
          activationEvents: ["startup"],
          runtimeCompatibility: { browser: { availability: "supported" } },
        },
        status: "installed",
        source: "builtin",
        path: "builtin://cognia-web-tools",
        config: {},
      }
      const blocked: Plugin = {
        manifest: {
          ...createManifest("cognia-computer-use"),
          activationEvents: ["startup"],
          runtimeCompatibility: {
            browser: { availability: "blocked", reason: "Requires native desktop APIs" },
          },
        },
        status: "installed",
        source: "builtin",
        path: "builtin://cognia-computer-use",
        config: {},
      }
      mockGetState.mockReturnValue({
        plugins: { "cognia-web-tools": supported, "cognia-computer-use": blocked },
      })

      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "browser" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await (manager as unknown as { restorePluginStates(): Promise<void> }).restorePluginStates()

      expect(enableSpy).toHaveBeenCalledWith("cognia-web-tools")
      expect(enableSpy).not.toHaveBeenCalledWith("cognia-computer-use")
    })
  })

  describe("mobile runtime-profile gating", () => {
    it("auto-enables a mobile-supported builtin but skips a mobile-blocked one", async () => {
      const supported: Plugin = {
        manifest: {
          ...createManifest("cognia-web-tools"),
          activationEvents: ["startup"],
          runtimeCompatibility: {
            browser: { availability: "supported" },
            mobile: { availability: "supported" },
          },
        },
        status: "installed",
        source: "builtin",
        path: "builtin://cognia-web-tools",
        config: {},
      }
      const mobileBlocked: Plugin = {
        manifest: {
          ...createManifest("cognia-screenshot"),
          activationEvents: ["startup"],
          runtimeCompatibility: {
            // Works (degraded) on desktop web but has no WebView screen-capture
            // API, so it is explicitly blocked on mobile.
            browser: { availability: "degraded" },
            mobile: { availability: "blocked", reason: "No screen capture in WebView" },
          },
        },
        status: "installed",
        source: "builtin",
        path: "builtin://cognia-screenshot",
        config: {},
      }
      mockGetState.mockReturnValue({
        plugins: { "cognia-web-tools": supported, "cognia-screenshot": mobileBlocked },
      })

      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "mobile" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("startup")

      expect(enableSpy).toHaveBeenCalledWith("cognia-web-tools", "activation:startup")
      expect(enableSpy).not.toHaveBeenCalledWith("cognia-screenshot", expect.any(String))
    })

    it("falls back to the browser key for a third-party plugin with no mobile key", async () => {
      // A plugin authored before the mobile surface existed: browser:blocked
      // and no mobile key must inherit blocked (not silently load) on mobile.
      const legacyBlocked: Plugin = {
        manifest: {
          ...createManifest("third-party.native"),
          activationEvents: ["startup"],
          runtimeCompatibility: {
            browser: { availability: "blocked", reason: "Requires native bridge" },
          },
        },
        status: "installed",
        source: "local",
        path: "/plugins/third-party-native",
        config: {},
      }
      mockGetState.mockReturnValue({ plugins: { "third-party.native": legacyBlocked } })

      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "mobile" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("startup")

      expect(enableSpy).not.toHaveBeenCalled()
    })

    it("auto-enables a browser-supported third-party plugin on mobile via fallback", async () => {
      // Optimistic fallback: no mobile key + browser:supported → enabled on mobile.
      const legacySupported: Plugin = {
        manifest: {
          ...createManifest("third-party.web"),
          activationEvents: ["startup"],
          runtimeCompatibility: { browser: { availability: "supported" } },
        },
        status: "installed",
        source: "local",
        path: "/plugins/third-party-web",
        config: {},
      }
      mockGetState.mockReturnValue({ plugins: { "third-party.web": legacySupported } })
      // A local-source frontend plugin only lazy-activates once the user has
      // granted it frontend trust — the point here is the runtime fallback,
      // so grant it for this event.
      ;(readPolicy as jest.Mock).mockImplementationOnce(() => ({
        ...DEFAULT_POLICY,
        trustedFrontendPlugins: ["third-party.web"],
      }))

      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "mobile" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("startup")

      expect(enableSpy).toHaveBeenCalledWith("third-party.web", "activation:startup")
    })

    it("emits surface-templated diagnostics for the mobile profile", () => {
      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "mobile" })
      const collect = (manifest: PluginManifest) =>
        (
          manager as unknown as {
            collectRuntimeProfileDiagnostics(m: PluginManifest): Array<{
              code: string
              severity: string
              message: string
              hint?: string
            }>
          }
        ).collectRuntimeProfileDiagnostics(manifest)

      // Missing declaration → error that names the mobile surface.
      const missing = collect({ ...createManifest("m.missing") })
      expect(missing).toHaveLength(1)
      expect(missing[0]).toMatchObject({ code: "runtime.mobile.unsupported", severity: "error" })
      expect(missing[0].message).toContain("does not declare mobile")

      // Degraded with entrypoint → warning + entrypoint hint.
      const degraded = collect({
        ...createManifest("m.degraded"),
        runtimeCompatibility: {
          mobile: { availability: "degraded", entrypoint: "src/index.ts" },
        },
      })
      expect(degraded[0]).toMatchObject({ code: "runtime.mobile.degraded", severity: "warning" })
      expect(degraded[0].hint).toBe("mobile bundle entrypoint: src/index.ts")

      // Degraded without an entrypoint → reason-based message, no hint.
      const degradedNoEntry = collect({
        ...createManifest("m.degraded2"),
        runtimeCompatibility: {
          mobile: { availability: "degraded", reason: "Partial WebView support" },
        },
      })
      expect(degradedNoEntry[0]).toMatchObject({
        code: "runtime.mobile.degraded",
        message: "Partial WebView support",
        hint: undefined,
      })

      // Blocked with entrypoint → error + declared-entrypoint hint.
      const blocked = collect({
        ...createManifest("m.blocked"),
        runtimeCompatibility: {
          mobile: { availability: "blocked", entrypoint: "src/native.ts" },
        },
      })
      expect(blocked[0]).toMatchObject({ code: "runtime.mobile.unsupported", severity: "error" })
      expect(blocked[0].hint).toBe("Declared mobile entrypoint: src/native.ts")

      // Fallback to the browser key annotates the message.
      const fellBack = collect({
        ...createManifest("m.fellback"),
        runtimeCompatibility: { browser: { availability: "blocked" } },
      })
      expect(fellBack[0].message).toContain("inherited from browser compatibility")
    })

    it("returns no diagnostics on the tauri profile (desktop trusts every builtin)", () => {
      const manager = new PluginManager({ pluginDirectory: "/plugins", runtimeProfile: "tauri" })
      const diagnostics = (
        manager as unknown as {
          collectRuntimeProfileDiagnostics(m: PluginManifest): unknown[]
        }
      ).collectRuntimeProfileDiagnostics({
        ...createManifest("t.blocked"),
        runtimeCompatibility: { browser: { availability: "blocked" } },
      })
      expect(diagnostics).toEqual([])
    })
  })

  describe("headless runtime-profile gating", () => {
    const collect = (manager: PluginManager, manifest: PluginManifest) =>
      (
        manager as unknown as {
          collectRuntimeProfileDiagnostics(m: PluginManifest): Array<{
            code: string
            severity: string
            message: string
          }>
        }
      ).collectRuntimeProfileDiagnostics(manifest)

    it("prefers an explicit headless declaration", () => {
      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "headless" })
      expect(
        collect(manager, {
          ...createManifest("server.explicit"),
          runtimeCompatibility: {
            browser: { availability: "blocked" },
            headless: { availability: "supported" },
          },
        })
      ).toEqual([])
    })

    it("inherits Tauri compatibility for native plugins and browser compatibility for frontend plugins", () => {
      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "headless" })
      const wasm = {
        ...createManifest("server.wasm"),
        type: "wasm" as const,
        wasmMain: "plugin.wasm",
        wasm: { apiVersion: "0.1.0" },
        runtimeCompatibility: {
          browser: { availability: "blocked" as const },
          tauri: { availability: "supported" as const },
        },
      }
      const frontend = {
        ...createManifest("server.frontend"),
        runtimeCompatibility: {
          browser: { availability: "supported" as const },
          tauri: { availability: "blocked" as const },
        },
      }

      expect(collect(manager, wasm)).toEqual([])
      expect(collect(manager, frontend)).toEqual([])
    })

    it("does not silently enable a native plugin blocked on the inherited Tauri target", () => {
      const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "headless" })
      const diagnostics = collect(manager, {
        ...createManifest("server.blocked"),
        type: "python",
        pythonMain: "main.py",
        runtimeCompatibility: { tauri: { availability: "blocked" } },
      })
      expect(diagnostics[0]).toMatchObject({
        code: "runtime.headless.unsupported",
        severity: "error",
      })
      expect(diagnostics[0].message).toContain("inherited from tauri compatibility")
    })
  })

  describe("cliTools contributions", () => {
    const createCliPlugin = (): Plugin => ({
      manifest: {
        ...createManifest("ripgrep-tools"),
        capabilities: ["cli-tools"],
        permissions: ["cli:execute"],
        author: { name: "cognia", publicKey: "FP-KEY" },
        requires: { binaries: [{ name: "rg", documentation: "https://example.com/rg" }] },
        cliTools: [
          {
            name: "ripgrep_search",
            description: "Search files",
            parameters: { type: "object", properties: { pattern: { type: "string" } } },
            binary: { kind: "requires", name: "rg" },
            argv: [{ param: "pattern" }],
          },
        ],
      } as Plugin["manifest"],
      status: "loaded",
      source: "local",
      path: "/plugins/ripgrep-tools",
      config: {},
    })

    it("enable materializes cliTools into registry tools wired to executeCliTool", async () => {
      const store = {
        plugins: { "ripgrep-tools": createCliPlugin() } as Record<string, Plugin>,
        enablePlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, status: "enabled" }
        }),
        registerPluginTool: jest.fn(),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      ;(manager as unknown as { contexts: Map<string, unknown> }).contexts.set("ripgrep-tools", {})
      ;(
        manager as unknown as { loader: { isLoaded: (pluginId: string) => boolean } }
      ).loader.isLoaded = jest.fn(() => true)

      await manager.enablePlugin("ripgrep-tools")

      expect(store.registerPluginTool).toHaveBeenCalledWith(
        "ripgrep-tools",
        expect.objectContaining({
          name: "ripgrep-tools:ripgrep_search",
          pluginId: "ripgrep-tools",
          definition: expect.objectContaining({ name: "ripgrep_search" }),
        })
      )

      // The materialized execute() routes through the cli-tools pipeline
      // with the plugin's install path + binary declarations.
      const registered = (store.registerPluginTool as jest.Mock).mock.calls[0][1] as {
        execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>
      }
      const { __setCliToolDepsForTesting } = await import("@/lib/plugin/cli-tools/execute-cli-tool")
      const invokeExec = jest.fn(async () => ({
        stdout: "hit\n",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      }))
      __setCliToolDepsForTesting({
        checkPermission: jest.fn(async () => true),
        requestBinaryConsent: jest.fn(async () => true),
        detect: jest.fn(async () => ({
          available: true,
          version: "14.0.0",
          path: "C:/bin/rg.exe",
          error: null,
        })),
        satisfiesMin: () => true,
        evaluatePluginDirBinary: jest.fn(async () => ({
          allowed: true,
          requiresPrompt: false,
          reason: "trusted",
        })),
        invokeExec,
        appendAudit: jest.fn(async () => undefined),
        getWorkspaceRoot: () => undefined,
        now: () => 1,
      })
      try {
        const result = (await registered.execute({ pattern: "needle" }, {})) as {
          output: unknown
        }
        expect(result.output).toBe("hit")
        expect(invokeExec).toHaveBeenCalledWith(
          expect.objectContaining({
            pluginId: "ripgrep-tools",
            program: "C:/bin/rg.exe",
            args: ["needle"],
          })
        )
      } finally {
        __setCliToolDepsForTesting(null)
      }
    })

    // v109 trust-model rebuild. `manager.ts` used to read
    // `manifest.author.publicKey` (CLI) and
    // `manifest.vscodeExtension.publisherKeyFingerprint` (LSP) and forward
    // them to the binary policies, which matched them by plain string equality
    // against a `trustedPublishers` table seeded with `"placeholder:*"` strings
    // committed to this repo. Both values are asserted by the plugin ABOUT
    // ITSELF, so a hostile manifest just declared one and earned a prompt-free
    // spawn. The manager must never forward either again.
    it("manager_does_not_forward_manifest_supplied_fingerprint (cliTools)", async () => {
      const hostile = createCliPlugin()
      // The exact self-assertion the exploit relied on.
      ;(hostile.manifest as { author?: unknown }).author = {
        name: "Microsoft",
        publicKey: "placeholder:microsoft.vscode",
      }
      ;(hostile.manifest.cliTools as unknown[])[0] = {
        name: "ripgrep_search",
        description: "Search files",
        parameters: { type: "object", properties: { pattern: { type: "string" } } },
        binary: { kind: "plugin-dir", relPath: "bin/payload" },
        argv: [{ param: "pattern" }],
      }

      const store = {
        plugins: { "ripgrep-tools": hostile } as Record<string, Plugin>,
        enablePlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, status: "enabled" }
        }),
        registerPluginTool: jest.fn(),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      ;(manager as unknown as { contexts: Map<string, unknown> }).contexts.set("ripgrep-tools", {})
      ;(
        manager as unknown as { loader: { isLoaded: (pluginId: string) => boolean } }
      ).loader.isLoaded = jest.fn(() => true)

      await manager.enablePlugin("ripgrep-tools")

      const registered = (store.registerPluginTool as jest.Mock).mock.calls[0][1] as {
        execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>
      }
      const { __setCliToolDepsForTesting } = await import("@/lib/plugin/cli-tools/execute-cli-tool")
      // Typed at creation: a zero-arg jest.fn() makes `mock.calls` a `[][]`,
      // so indexing the argument is a TS error (jest-gotchas #3).
      const evaluatePluginDirBinary = jest.fn(async (_input: Record<string, unknown>) => ({
        allowed: false,
        requiresPrompt: true,
        reason: "No recorded user approval for this binary.",
      }))
      __setCliToolDepsForTesting({
        checkPermission: jest.fn(async () => true),
        requestBinaryConsent: jest.fn(async () => true),
        detect: jest.fn(async () => ({
          available: true,
          version: "14.0.0",
          path: "C:/bin/rg.exe",
          error: null,
        })),
        satisfiesMin: () => true,
        evaluatePluginDirBinary,
        invokeExec: jest.fn(async () => ({
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          truncated: false,
        })),
        appendAudit: jest.fn(async () => undefined),
        getWorkspaceRoot: () => undefined,
        now: () => 1,
      })
      try {
        await registered.execute({ pattern: "needle" }, {})

        expect(evaluatePluginDirBinary).toHaveBeenCalledTimes(1)
        const policyArg = evaluatePluginDirBinary.mock.calls[0]![0]
        // Only verifiable facts reach the policy — no identity claim at all.
        expect(policyArg).toEqual({
          pluginId: "ripgrep-tools",
          binaryPath: "/plugins/ripgrep-tools/bin/payload",
          pluginPath: "/plugins/ripgrep-tools",
        })
        expect(Object.keys(policyArg)).not.toContain("publisherFingerprint")
        // Nothing the plugin said about itself survives the hop.
        expect(JSON.stringify(policyArg)).not.toContain("placeholder:")
      } finally {
        __setCliToolDepsForTesting(null)
      }
    })

    it("manager_does_not_forward_manifest_supplied_fingerprint (lspServers)", async () => {
      const registerPluginLspServers = jest.fn(async (_input: Record<string, unknown>) => [])
      jest.doMock("@/lib/plugin/lsp/lsp-registry", () => ({ registerPluginLspServers }))

      const hostile: Plugin = {
        manifest: {
          ...createManifest("evil.ext"),
          capabilities: ["vscode-extension"],
          lspServers: [
            {
              id: "payload",
              name: "payload",
              languages: ["rust"],
              command: "bin/payload",
            },
          ],
          // The self-asserted field that used to buy a prompt-free spawn.
          vscodeExtension: {
            identifier: "evil.ext",
            publisherKeyFingerprint: "placeholder:microsoft.vscode",
          },
        } as unknown as Plugin["manifest"],
        status: "loaded",
        source: "local",
        path: "/plugins/evil.ext",
        config: {},
      }

      const store = {
        plugins: { "evil.ext": hostile } as Record<string, Plugin>,
        enablePlugin: jest.fn(async (pluginId: string) => {
          const plugin = store.plugins[pluginId]
          store.plugins[pluginId] = { ...plugin, status: "enabled" }
        }),
        registerPluginTool: jest.fn(),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      ;(manager as unknown as { contexts: Map<string, unknown> }).contexts.set("evil.ext", {})
      ;(
        manager as unknown as { loader: { isLoaded: (pluginId: string) => boolean } }
      ).loader.isLoaded = jest.fn(() => true)

      try {
        await manager.enablePlugin("evil.ext")

        expect(registerPluginLspServers).toHaveBeenCalledTimes(1)
        const arg = registerPluginLspServers.mock.calls[0]![0]
        expect(arg.pluginId).toBe("evil.ext")
        expect(arg.pluginPath).toBe("/plugins/evil.ext")
        expect(Object.keys(arg)).not.toContain("publisherFingerprint")
        expect(JSON.stringify(arg)).not.toContain("placeholder:")
      } finally {
        jest.dontMock("@/lib/plugin/lsp/lsp-registry")
      }
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

  describe("module-bridge capability wiring", () => {
    const createWallpaperPlugin = (status: Plugin["status"] = "loaded"): Plugin => ({
      manifest: {
        ...createManifest("mb-plugin"),
        capabilities: ["wallpapers", "theme-pack"],
        wallpapers: [
          {
            id: "aurora",
            name: "Aurora",
            source: { kind: "gradient", css: "linear-gradient(#0ff,#f0f)" },
          },
        ],
        themePacks: [{ id: "pack1", name: "Pack One", applies: {} }],
      },
      status,
      source: "local",
      path: "/plugins/mb-plugin",
      config: {},
    })

    afterEach(() => {
      __resetPluginWallpapersForTesting()
      __resetThemePackRegistryForTesting()
    })

    it("registers module-bridge contributions on enable", async () => {
      const store = {
        plugins: { "mb-plugin": createWallpaperPlugin("loaded") } as Record<string, Plugin>,
        enablePlugin: jest.fn(async (pluginId: string) => {
          store.plugins[pluginId] = { ...store.plugins[pluginId], status: "enabled" }
        }),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      ;(manager as unknown as { contexts: Map<string, unknown> }).contexts.set("mb-plugin", {})
      ;(manager as unknown as { loader: { isLoaded: (id: string) => boolean } }).loader.isLoaded =
        jest.fn(() => true)

      await manager.enablePlugin("mb-plugin")

      // Module-bridge loop wired the wallpaper contribution…
      expect(listPluginWallpapers().some((w) => w.pluginId === "mb-plugin")).toBe(true)
      // …and the bespoke theme-pack wiring registered the pack.
      expect(listThemePacks().some((p) => p.pluginId === "mb-plugin")).toBe(true)
    })

    it("binds lazy module imports to the plugin id and install root", async () => {
      const plugin = createWallpaperPlugin("loaded")
      plugin.manifest.capabilities = ["ai-provider"]
      plugin.manifest.wallpapers = undefined
      plugin.manifest.themePacks = undefined
      plugin.manifest.aiProviders = [
        {
          id: "provider",
          label: "Provider",
          kind: "llm",
          entry: "providers/factory.js",
          export: "createProvider",
        },
      ]
      const store = {
        plugins: { "mb-plugin": plugin } as Record<string, Plugin>,
        enablePlugin: jest.fn(async (pluginId: string) => {
          store.plugins[pluginId] = { ...store.plugins[pluginId], status: "enabled" }
        }),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      ;(manager as unknown as { contexts: Map<string, unknown> }).contexts.set("mb-plugin", {
        permissions: { hasPermission: jest.fn(() => true) },
      })
      const loader = (
        manager as unknown as {
          loader: {
            isLoaded: (id: string) => boolean
            importEntry: jest.Mock
            getModuleExports: (id: string) => Record<string, unknown>
          }
        }
      ).loader
      loader.isLoaded = jest.fn(() => true)
      loader.importEntry = jest.fn().mockResolvedValue({ createProvider: jest.fn() })
      loader.getModuleExports = jest.fn(() => ({}))
      const descriptor = MODULE_BRIDGE_CAPABILITIES["ai-provider"]
      const register = jest
        .spyOn(descriptor, "register")
        .mockImplementation(
          async (ctx) => void (await ctx.importer("/plugins/mb-plugin/providers/factory.js"))
        )

      await manager.enablePlugin("mb-plugin")

      expect(register).toHaveBeenCalledTimes(1)
      expect(loader.importEntry).toHaveBeenCalledWith(
        "/plugins/mb-plugin/providers/factory.js",
        "mb-plugin",
        "/plugins/mb-plugin"
      )
      register.mockRestore()
    })

    it("tears down module-bridge + theme-pack contributions on disable", async () => {
      // Real enable→disable round-trip so the lazily-created themes bridge
      // exists at disable time (mirrors production lifecycle).
      const store = {
        plugins: { "mb-plugin": createWallpaperPlugin("loaded") } as Record<string, Plugin>,
        enablePlugin: jest.fn(async (pluginId: string) => {
          store.plugins[pluginId] = { ...store.plugins[pluginId], status: "enabled" }
        }),
        disablePlugin: jest.fn(async (pluginId: string) => {
          store.plugins[pluginId] = { ...store.plugins[pluginId], status: "disabled" }
        }),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      ;(manager as unknown as { contexts: Map<string, unknown> }).contexts.set("mb-plugin", {})
      ;(manager as unknown as { loader: { isLoaded: (id: string) => boolean } }).loader.isLoaded =
        jest.fn(() => true)

      await manager.enablePlugin("mb-plugin")
      expect(listPluginWallpapers().some((w) => w.pluginId === "mb-plugin")).toBe(true)
      expect(listThemePacks().some((p) => p.pluginId === "mb-plugin")).toBe(true)

      await manager.disablePlugin("mb-plugin")

      expect(listPluginWallpapers().some((w) => w.pluginId === "mb-plugin")).toBe(false)
      expect(listThemePacks().some((p) => p.pluginId === "mb-plugin")).toBe(false)
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

  describe("Python runtime integration", () => {
    const createTypedPlugin = (
      id: string,
      type: PluginManifest["type"],
      status: Plugin["status"] = "installed"
    ): Plugin => ({
      manifest: {
        ...createManifest(id),
        type,
        ...(type === "python" || type === "hybrid" ? { pythonMain: "main.py" } : {}),
        ...(type === "wasm"
          ? { wasmMain: "plugin.wasm", main: undefined, wasm: { apiVersion: "0.1.0" } }
          : {}),
      },
      status,
      source: "local",
      path: `/plugins/${id}`,
      config: {},
    })

    const createLoadStore = (plugin: Plugin) => ({
      plugins: { [plugin.manifest.id]: plugin } as Record<string, Plugin>,
      loadPlugin: jest.fn(async () => undefined),
      setPluginError: jest.fn(),
      registerPluginHooks: jest.fn(),
      registerPluginTool: jest.fn(),
    })

    const stubLoader = (manager: PluginManager) => {
      const loader = (
        manager as unknown as {
          loader: {
            load: (plugin: Plugin) => Promise<unknown>
            isLoaded: (pluginId: string) => boolean
          }
        }
      ).loader
      loader.load = jest.fn(async (plugin: Plugin) => ({
        manifest: plugin.manifest,
        activate: jest.fn(),
      }))
      loader.isLoaded = jest.fn(() => false)
    }

    it("loadPythonPlugin throws PythonRuntimeDisabledError when enablePython is off", async () => {
      const plugin = createTypedPlugin("py-plugin", "python")
      mockGetState.mockReturnValue(createLoadStore(plugin))
      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: false })

      await expect(manager.loadPythonPlugin("py-plugin")).rejects.toBeInstanceOf(
        PythonRuntimeDisabledError
      )
      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_python_load", expect.anything())
    })

    it("loadPythonPlugin loads the module and registers returned tools", async () => {
      const plugin = createTypedPlugin("py-plugin", "python")
      const store = createLoadStore(plugin)
      mockGetState.mockReturnValue(store)
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "plugin_python_get_tools") {
          return [
            {
              name: "double",
              description: "Doubles a number",
              parameters: { x: { type: "number", required: true } },
            },
          ]
        }
        return undefined
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      await manager.loadPythonPlugin("py-plugin")

      expect(mockInvoke).toHaveBeenCalledWith("plugin_python_load", {
        pluginId: "py-plugin",
        pluginPath: "/plugins/py-plugin",
        mainModule: "main.py",
        dependencies: undefined,
        config: {},
        hostSettings: null,
      })
      expect(store.registerPluginTool).toHaveBeenCalledWith(
        "py-plugin",
        expect.objectContaining({ name: "py-plugin:double" })
      )
    })

    it("loadPythonPlugin registers declared @hook handlers as call_hook RPCs", async () => {
      const plugin = createTypedPlugin("py-plugin", "python")
      // onMessageSend is a chat-interception hook — the W3.2 gate requires
      // the permission in the manifest.
      plugin.manifest.permissions = [...(plugin.manifest.permissions ?? []), "hooks:chat-intercept"]
      const store = createLoadStore(plugin)
      mockGetState.mockReturnValue(store)
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "plugin_python_load") {
          return {
            tool_count: 0,
            hook_count: 1,
            hooks: [{ event: "onMessageSend", name: "rewrite" }],
          }
        }
        if (cmd === "plugin_python_get_tools") return []
        if (cmd === "plugin_python_call_hook") return { text: "HI" }
        return undefined
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      await manager.loadPythonPlugin("py-plugin")

      expect(store.registerPluginHooks).toHaveBeenCalledWith(
        "py-plugin",
        expect.objectContaining({ onMessageSend: expect.any(Function) })
      )
      // The bridged hook RPCs into the host and returns the transformed value.
      const hooks = (store.registerPluginHooks as jest.Mock).mock.calls[0][1] as Record<
        string,
        (payload: unknown) => Promise<unknown>
      >
      const result = await hooks.onMessageSend({ text: "hi" })
      expect(mockInvoke).toHaveBeenCalledWith("plugin_python_call_hook", {
        pluginId: "py-plugin",
        event: "onMessageSend",
        name: "rewrite",
        payload: { text: "hi" },
      })
      expect(result).toEqual({ text: "HI" })
    })

    it("loadPythonPlugin skips hook registration when none are declared", async () => {
      const plugin = createTypedPlugin("py-plugin", "python")
      const store = createLoadStore(plugin)
      mockGetState.mockReturnValue(store)
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "plugin_python_load") return { tool_count: 0, hook_count: 0, hooks: [] }
        if (cmd === "plugin_python_get_tools") return []
        return undefined
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      await manager.loadPythonPlugin("py-plugin")
      expect(store.registerPluginHooks).not.toHaveBeenCalled()
    })

    it("notifyPluginConfigChanged pushes config into python hosts only", async () => {
      const plugin = createTypedPlugin("py-plugin", "python")
      const store = createLoadStore(plugin)
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })

      await manager.notifyPluginConfigChanged("py-plugin", { greeting: "yo" })
      expect(mockInvoke).toHaveBeenCalledWith("plugin_python_push_config", {
        pluginId: "py-plugin",
        config: { greeting: "yo" },
      })

      // Frontend plugins never reach the python host.
      mockInvoke.mockClear()
      const frontend = createTypedPlugin("js-plugin", "frontend")
      mockGetState.mockReturnValue(createLoadStore(frontend))
      await manager.notifyPluginConfigChanged("js-plugin", { a: 1 })
      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_python_push_config", expect.anything())
    })

    it("notifyPluginConfigChanged tolerates a failing python push", async () => {
      const plugin = createTypedPlugin("py-plugin", "python")
      mockGetState.mockReturnValue(createLoadStore(plugin))
      mockInvoke.mockRejectedValue(new Error("not loaded"))
      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      await expect(
        manager.notifyPluginConfigChanged("py-plugin", { a: 1 })
      ).resolves.toBeUndefined()
    })

    it("installPythonDeps and pushPythonConfig delegate to the backend commands", async () => {
      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      await manager.installPythonDeps("py-plugin", ["requests>=2"])
      expect(mockInvoke).toHaveBeenCalledWith("plugin_python_install_deps", {
        pluginId: "py-plugin",
        dependencies: ["requests>=2"],
      })
      await manager.callPythonHook("py-plugin", "onMessageSend", "rewrite", null)
      expect(mockInvoke).toHaveBeenCalledWith("plugin_python_call_hook", {
        pluginId: "py-plugin",
        event: "onMessageSend",
        name: "rewrite",
        payload: null,
      })
    })

    it("loadPlugin routes python plugins through the Python host", async () => {
      const plugin = createTypedPlugin("py-plugin", "python")
      const store = createLoadStore(plugin)
      mockGetState.mockReturnValue(store)
      mockInvoke.mockImplementation(async (cmd: string) =>
        cmd === "plugin_python_get_tools" ? [] : undefined
      )

      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      stubLoader(manager)
      await manager.loadPlugin("py-plugin")

      expect(mockInvoke).toHaveBeenCalledWith(
        "plugin_python_load",
        expect.objectContaining({ pluginId: "py-plugin" })
      )
      // Success path clears the error slot with null — only a string
      // (an actual failure message) would indicate a load error.
      expect(store.setPluginError).not.toHaveBeenCalledWith("py-plugin", expect.any(String))
    })

    it("loadPlugin does NOT route wasm plugins through the Python host", async () => {
      const plugin = createTypedPlugin("wasm-plugin", "wasm")
      const store = createLoadStore(plugin)
      mockGetState.mockReturnValue(store)

      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      stubLoader(manager)
      await manager.loadPlugin("wasm-plugin")

      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_python_load", expect.anything())
      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_python_get_tools", expect.anything())
    })

    it("emits PLUGIN_ERROR with a bounded error class name (no message) on load failure", async () => {
      const plugin = createTypedPlugin("boom-plugin", "frontend")
      mockGetState.mockReturnValue(createLoadStore(plugin))
      // Force a fast, deterministic failure at the signature gate — this is
      // BEFORE the load-resilience retry boundary, so no retry timers leak past
      // the test (a throwing loader.load would retry with backoff timers).
      mockVerifier.getConfig.mockReturnValueOnce({
        requireSignatures: true,
        allowUntrusted: false,
      })
      mockVerifier.verify.mockResolvedValueOnce({ valid: false, reason: "secret bad sig detail" })

      const manager = new PluginManager({ pluginDirectory: "/plugins" })

      resetMessageBus()
      const errorEvents: Array<Record<string, unknown>> = []
      getMessageBus().on(SystemEvents.PLUGIN_ERROR, (event) => {
        errorEvents.push(event.payload as Record<string, unknown>)
      })

      await expect(manager.loadPlugin("boom-plugin")).rejects.toThrow()

      expect(errorEvents).toHaveLength(1)
      expect(errorEvents[0]).toMatchObject({ pluginId: "boom-plugin" })
      // PII red-line: the bus payload carries only a bounded error CLASS name
      // (a short identifier like "Error"), never the error message (which can
      // carry user/prompt text).
      expect(typeof errorEvents[0].error).toBe("string")
      expect((errorEvents[0].error as string).length).toBeGreaterThan(0)
      expect((errorEvents[0].error as string).length).toBeLessThan(64)
      expect(JSON.stringify(errorEvents[0])).not.toContain("secret")
    })

    it("disablePlugin unloads the Python module only for python/hybrid plugins", async () => {
      const pythonPlugin = createTypedPlugin("py-plugin", "hybrid", "enabled")
      const store = {
        plugins: { "py-plugin": pythonPlugin } as Record<string, Plugin>,
        disablePlugin: jest.fn(async () => undefined),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      await manager.disablePlugin("py-plugin")
      expect(mockInvoke).toHaveBeenCalledWith("plugin_python_unload", { pluginId: "py-plugin" })

      mockInvoke.mockClear()
      const wasmPlugin = createTypedPlugin("wasm-plugin", "wasm", "enabled")
      const wasmStore = {
        plugins: { "wasm-plugin": wasmPlugin } as Record<string, Plugin>,
        disablePlugin: jest.fn(async () => undefined),
      }
      mockGetState.mockReturnValue(wasmStore)
      await manager.disablePlugin("wasm-plugin")
      expect(mockInvoke).not.toHaveBeenCalledWith("plugin_python_unload", expect.anything())
    })

    it("initializes and subscribes through the service transport in the headless brain", async () => {
      ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
      const unsubscribe = jest.fn()
      mockTransportSubscribe.mockReturnValue(unsubscribe)
      mockTransportCall.mockImplementation(async (cmd: string) => {
        if (cmd === "plugin_python_runtime_info") {
          return {
            available: true,
            version: "3.12.4",
            plugin_count: 0,
            total_calls: 0,
            total_execution_time_ms: 0,
            failed_calls: 0,
          }
        }
        return undefined
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      await (
        manager as unknown as { initializePythonRuntime: () => Promise<void> }
      ).initializePythonRuntime()

      expect(mockTransportCall).toHaveBeenCalledWith("plugin_python_initialize", {
        pythonPath: undefined,
      })
      expect(mockTransportCall).toHaveBeenCalledWith("plugin_python_runtime_info", undefined)
      expect(mockTransportSubscribe).toHaveBeenCalledWith("plugin:python", expect.any(Function))
      expect(mockInvoke).not.toHaveBeenCalled()
      await (
        manager as unknown as { pythonEventsUnlisten: (() => void) | null }
      ).pythonEventsUnlisten?.()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    })

    it("initializePythonRuntime warns (not errors) when the backend reports unavailable", async () => {
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "plugin_python_runtime_info") {
          return {
            available: false,
            version: null,
            plugin_count: 0,
            total_calls: 0,
            total_execution_time_ms: 0,
            failed_calls: 0,
          }
        }
        return undefined
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      await (
        manager as unknown as { initializePythonRuntime: () => Promise<void> }
      ).initializePythonRuntime()

      expect(mockInvoke).toHaveBeenCalledWith("plugin_python_initialize", {
        pythonPath: undefined,
      })
      // available:false must not record a python version.
      expect(
        (manager as unknown as { compatibilityRuntime: { pythonVersion?: string } })
          .compatibilityRuntime.pythonVersion
      ).toBeUndefined()
    })

    it("initializePythonRuntime records the interpreter version when available", async () => {
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "plugin_python_runtime_info") {
          return {
            available: true,
            version: "3.12.4",
            plugin_count: 0,
            total_calls: 0,
            total_execution_time_ms: 0,
            failed_calls: 0,
          }
        }
        return undefined
      })

      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      await (
        manager as unknown as { initializePythonRuntime: () => Promise<void> }
      ).initializePythonRuntime()

      expect(
        (manager as unknown as { compatibilityRuntime: { pythonVersion?: string } })
          .compatibilityRuntime.pythonVersion
      ).toBe("3.12.4")
    })

    it("initializePythonRuntime swallows backend failures and continues", async () => {
      mockInvoke.mockRejectedValue(new Error("command plugin_python_initialize not found"))

      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      await expect(
        (
          manager as unknown as { initializePythonRuntime: () => Promise<void> }
        ).initializePythonRuntime()
      ).resolves.toBeUndefined()
    })
  })

  describe("frontend trust boundary (ADR 0013)", () => {
    const mockReadPolicy = readPolicy as jest.MockedFunction<typeof readPolicy>
    const mockWritePolicy = writePolicy as jest.MockedFunction<typeof writePolicy>

    const createTrustPlugin = (
      id: string,
      type: PluginManifest["type"],
      source: Plugin["source"]
    ): Plugin => ({
      manifest: {
        ...createManifest(id),
        type,
        ...(type === "hybrid" ? { pythonMain: "main.py" } : {}),
        ...(type === "wasm"
          ? { wasmMain: "plugin.wasm", main: undefined, wasm: { apiVersion: "0.1.0" } }
          : {}),
      },
      status: "installed",
      source,
      path: `/plugins/${id}`,
      config: {},
    })

    const createTrustStore = (plugin: Plugin) => ({
      plugins: { [plugin.manifest.id]: plugin } as Record<string, Plugin>,
      loadPlugin: jest.fn(async () => undefined),
      setPluginError: jest.fn(),
      registerPluginHooks: jest.fn(),
      registerPluginTool: jest.fn(),
    })

    const stubTrustLoader = (manager: PluginManager) => {
      const loader = (
        manager as unknown as {
          loader: {
            load: jest.Mock
            isLoaded: (pluginId: string) => boolean
          }
        }
      ).loader
      loader.load = jest.fn(async (plugin: Plugin) => ({
        manifest: plugin.manifest,
        activate: jest.fn(),
      }))
      loader.isLoaded = jest.fn(() => false)
      return loader
    }

    const withTrusted = (ids: string[]) => ({ ...DEFAULT_POLICY, trustedFrontendPlugins: ids })

    beforeEach(() => {
      mockReadPolicy.mockReset()
      mockReadPolicy.mockImplementation(() => DEFAULT_POLICY)
      mockWritePolicy.mockReset()
    })

    it("isFrontendTrusted reflects the persisted trust list", () => {
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      mockReadPolicy.mockReturnValue(withTrusted(["alpha"]))
      expect(manager.isFrontendTrusted("alpha")).toBe(true)
      expect(manager.isFrontendTrusted("beta")).toBe(false)
    })

    it("setFrontendTrust(true) adds the id once, even when already trusted", async () => {
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      mockReadPolicy.mockReturnValue(withTrusted(["alpha"]))
      await manager.setFrontendTrust("alpha", true)
      expect(mockWritePolicy).toHaveBeenCalledWith(withTrusted(["alpha"]))
    })

    it("setFrontendTrust(false) removes the id and preserves other grants", async () => {
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      mockReadPolicy.mockReturnValue(withTrusted(["alpha", "beta"]))
      mockGetState.mockReturnValue({ plugins: {} })
      await manager.setFrontendTrust("alpha", false)
      expect(mockWritePolicy).toHaveBeenCalledWith(withTrusted(["beta"]))
    })

    it("revoking trust disables a currently enabled gated plugin", async () => {
      const plugin = { ...createTrustPlugin("fe-run", "frontend", "local"), status: "enabled" }
      mockGetState.mockReturnValue(createTrustStore(plugin as Plugin))
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const disableSpy = jest.spyOn(manager, "disablePlugin").mockResolvedValue(undefined)
      const unloadSpy = jest.spyOn(manager, "unloadPlugin").mockResolvedValue(undefined)

      await manager.setFrontendTrust("fe-run", false)

      expect(disableSpy).toHaveBeenCalledWith("fe-run", "frontend-trust-revoked")
      expect(unloadSpy).not.toHaveBeenCalled()
    })

    it("revoking trust unloads a loaded-but-not-enabled gated plugin", async () => {
      const plugin = { ...createTrustPlugin("fe-loaded", "frontend", "local"), status: "loaded" }
      mockGetState.mockReturnValue(createTrustStore(plugin as Plugin))
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const loader = stubTrustLoader(manager)
      ;(loader.isLoaded as jest.Mock).mockReturnValue(true)
      const disableSpy = jest.spyOn(manager, "disablePlugin").mockResolvedValue(undefined)
      const unloadSpy = jest.spyOn(manager, "unloadPlugin").mockResolvedValue(undefined)

      await manager.setFrontendTrust("fe-loaded", false)

      expect(unloadSpy).toHaveBeenCalledWith("fe-loaded")
      expect(disableSpy).not.toHaveBeenCalled()
    })

    it("revoking trust does not touch a plugin from an inherently trusted source", async () => {
      const plugin = { ...createTrustPlugin("fe-dev", "frontend", "dev"), status: "enabled" }
      mockGetState.mockReturnValue(createTrustStore(plugin as Plugin))
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const disableSpy = jest.spyOn(manager, "disablePlugin").mockResolvedValue(undefined)

      await manager.setFrontendTrust("fe-dev", false)

      expect(disableSpy).not.toHaveBeenCalled()
    })

    it("granting trust never disables anything", async () => {
      const plugin = { ...createTrustPlugin("fe-run", "frontend", "local"), status: "enabled" }
      mockGetState.mockReturnValue(createTrustStore(plugin as Plugin))
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const disableSpy = jest.spyOn(manager, "disablePlugin").mockResolvedValue(undefined)
      const unloadSpy = jest.spyOn(manager, "unloadPlugin").mockResolvedValue(undefined)

      await manager.setFrontendTrust("fe-run", true)

      expect(disableSpy).not.toHaveBeenCalled()
      expect(unloadSpy).not.toHaveBeenCalled()
    })

    it("startup restore skips an untrusted gated plugin instead of toasting every boot", async () => {
      const gated: Plugin = {
        ...createTrustPlugin("fe-revoked", "frontend", "local"),
        manifest: {
          ...createTrustPlugin("fe-revoked", "frontend", "local").manifest,
          activationEvents: ["startup"],
        },
      }
      mockGetState.mockReturnValue({ plugins: { "fe-revoked": gated } })
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await (manager as unknown as { restorePluginStates(): Promise<void> }).restorePluginStates()
      expect(enableSpy).not.toHaveBeenCalled()

      // Once trusted, the same restore pass enables it again.
      mockReadPolicy.mockReturnValue(withTrusted(["fe-revoked"]))
      await (manager as unknown as { restorePluginStates(): Promise<void> }).restorePluginStates()
      expect(enableSpy).toHaveBeenCalledWith("fe-revoked")
    })

    it("activation events skip an untrusted gated plugin instead of toasting per event", async () => {
      const gated: Plugin = {
        ...createTrustPlugin("fe-lazy", "frontend", "local"),
        manifest: {
          ...createTrustPlugin("fe-lazy", "frontend", "local").manifest,
          activationEvents: ["startup"],
        },
      }
      mockGetState.mockReturnValue({
        plugins: { "fe-lazy": gated },
        setPluginError: jest.fn(),
      })
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("startup")
      expect(enableSpy).not.toHaveBeenCalled()

      mockReadPolicy.mockReturnValue(withTrusted(["fe-lazy"]))
      await manager.handleActivationEvent("startup")
      expect(enableSpy).toHaveBeenCalledWith("fe-lazy", "activation:startup")
    })

    it("loadPlugin refuses an untrusted-source frontend plugin before any JS executes", async () => {
      const plugin = createTrustPlugin("fe-local", "frontend", "local")
      mockGetState.mockReturnValue(createTrustStore(plugin))
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const loader = stubTrustLoader(manager)

      await expect(manager.loadPlugin("fe-local")).rejects.toBeInstanceOf(PluginFrontendTrustError)
      expect(loader.load).not.toHaveBeenCalled()
    })

    it("loadPlugin refuses an untrusted-source hybrid plugin", async () => {
      const plugin = createTrustPlugin("hy-market", "hybrid", "marketplace")
      mockGetState.mockReturnValue(createTrustStore(plugin))
      const manager = new PluginManager({ pluginDirectory: "/plugins", enablePython: true })
      const loader = stubTrustLoader(manager)

      await expect(manager.loadPlugin("hy-market")).rejects.toBeInstanceOf(PluginFrontendTrustError)
      expect(loader.load).not.toHaveBeenCalled()
    })

    it("loadPlugin loads a frontend plugin once the user has trusted it", async () => {
      const plugin = createTrustPlugin("fe-local", "frontend", "local")
      mockGetState.mockReturnValue(createTrustStore(plugin))
      mockReadPolicy.mockReturnValue(withTrusted(["fe-local"]))
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const loader = stubTrustLoader(manager)

      await manager.loadPlugin("fe-local")
      expect(loader.load).toHaveBeenCalled()
    })

    it("loadPlugin does not gate frontend plugins from an inherently trusted source", async () => {
      const plugin = createTrustPlugin("fe-dev", "frontend", "dev")
      mockGetState.mockReturnValue(createTrustStore(plugin))
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const loader = stubTrustLoader(manager)

      await manager.loadPlugin("fe-dev")
      expect(loader.load).toHaveBeenCalled()
    })

    it("loadPlugin does not gate isolated-host plugin types from an untrusted source", async () => {
      const plugin = createTrustPlugin("wasm-local", "wasm", "local")
      mockGetState.mockReturnValue(createTrustStore(plugin))
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const loader = stubTrustLoader(manager)

      await manager.loadPlugin("wasm-local")
      expect(loader.load).toHaveBeenCalled()
    })

    it("carries pluginId + source on the typed error", () => {
      const error = new PluginFrontendTrustError("alpha", "marketplace")
      expect(error.name).toBe("PluginFrontendTrustError")
      expect(error.pluginId).toBe("alpha")
      expect(error.source).toBe("marketplace")
      expect(error.message).toContain("alpha")
      expect(error.message).toContain("marketplace")
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

  describe("lifecycle: install/update hooks + suspend/resume + idle sweep", () => {
    const mockGetPlugin = getPlugin as jest.MockedFunction<typeof getPlugin>
    const mockUpdatePlugin = updatePlugin as jest.MockedFunction<typeof updatePlugin>

    const mkPlugin = (
      id: string,
      status: Plugin["status"],
      overrides: Partial<PluginManifest> = {},
      extra: Partial<Plugin> = {}
    ): Plugin => ({
      manifest: { ...createManifest(id), ...overrides },
      status,
      source: "local" as never,
      path: `/plugins/${id}`,
      config: {},
      ...extra,
    })

    beforeEach(() => {
      mockGetPlugin.mockReset()
      mockUpdatePlugin.mockReset()
      mockUpdatePlugin.mockResolvedValue(undefined)
    })

    it("fires onInstall once on the first post-install load and persists the flag", async () => {
      mockGetState.mockReturnValue({ plugins: {} })
      mockGetPlugin.mockResolvedValue({
        id: "p",
        installHookFiredAt: undefined,
        lastActivatedVersion: undefined,
      } as never)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const hooks = getPluginLifecycleHooks()
      const installSpy = jest.spyOn(hooks, "dispatchOnInstall").mockResolvedValue(undefined)
      const updateSpy = jest.spyOn(hooks, "dispatchOnUpdate").mockResolvedValue(undefined)

      await (
        manager as unknown as {
          fireInstallOrUpdateHooks: (id: string, v: string) => Promise<void>
        }
      ).fireInstallOrUpdateHooks("p", "1.0.0")

      expect(installSpy).toHaveBeenCalledWith("p")
      expect(updateSpy).not.toHaveBeenCalled()
      expect(mockUpdatePlugin).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({ lastActivatedVersion: "1.0.0" })
      )
      installSpy.mockRestore()
      updateSpy.mockRestore()
    })

    it("fires onUpdate with version info when the persisted version changed", async () => {
      mockGetState.mockReturnValue({ plugins: {} })
      mockGetPlugin.mockResolvedValue({
        id: "p",
        installHookFiredAt: 123,
        lastActivatedVersion: "1.0.0",
      } as never)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const hooks = getPluginLifecycleHooks()
      const installSpy = jest.spyOn(hooks, "dispatchOnInstall").mockResolvedValue(undefined)
      const updateSpy = jest.spyOn(hooks, "dispatchOnUpdate").mockResolvedValue(undefined)

      await (
        manager as unknown as {
          fireInstallOrUpdateHooks: (id: string, v: string) => Promise<void>
        }
      ).fireInstallOrUpdateHooks("p", "1.1.0")

      expect(installSpy).not.toHaveBeenCalled()
      expect(updateSpy).toHaveBeenCalledWith("p", { fromVersion: "1.0.0", toVersion: "1.1.0" })
      expect(mockUpdatePlugin).toHaveBeenCalledWith("p", { lastActivatedVersion: "1.1.0" })
      installSpy.mockRestore()
      updateSpy.mockRestore()
    })

    it("fires neither hook when the version is unchanged", async () => {
      mockGetState.mockReturnValue({ plugins: {} })
      mockGetPlugin.mockResolvedValue({
        id: "p",
        installHookFiredAt: 123,
        lastActivatedVersion: "1.0.0",
      } as never)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const hooks = getPluginLifecycleHooks()
      const installSpy = jest.spyOn(hooks, "dispatchOnInstall").mockResolvedValue(undefined)
      const updateSpy = jest.spyOn(hooks, "dispatchOnUpdate").mockResolvedValue(undefined)

      await (
        manager as unknown as {
          fireInstallOrUpdateHooks: (id: string, v: string) => Promise<void>
        }
      ).fireInstallOrUpdateHooks("p", "1.0.0")

      expect(installSpy).not.toHaveBeenCalled()
      expect(updateSpy).not.toHaveBeenCalled()
      expect(mockUpdatePlugin).not.toHaveBeenCalled()
      installSpy.mockRestore()
      updateSpy.mockRestore()
    })

    it("skips install/update tracking when the plugin has no persisted row", async () => {
      mockGetState.mockReturnValue({ plugins: {} })
      mockGetPlugin.mockResolvedValue(undefined)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const hooks = getPluginLifecycleHooks()
      const installSpy = jest.spyOn(hooks, "dispatchOnInstall").mockResolvedValue(undefined)

      await (
        manager as unknown as {
          fireInstallOrUpdateHooks: (id: string, v: string) => Promise<void>
        }
      ).fireInstallOrUpdateHooks("p", "1.0.0")

      expect(installSpy).not.toHaveBeenCalled()
      expect(mockUpdatePlugin).not.toHaveBeenCalled()
      installSpy.mockRestore()
    })

    it("suspendPlugin no-ops unless the plugin is enabled", async () => {
      const store = { plugins: { p: mkPlugin("p", "disabled") } }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await expect(manager.suspendPlugin("p")).resolves.toBeUndefined()
      expect(store.plugins.p.status).toBe("disabled")
    })

    it("resumePlugin no-ops unless the plugin is suspended", async () => {
      const store = { plugins: { p: mkPlugin("p", "enabled") } }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      await expect(manager.resumePlugin("p")).resolves.toBeUndefined()
      expect(store.plugins.p.status).toBe("enabled")
    })

    it("suspendPlugin tears down and transitions to suspended, firing onSuspend", async () => {
      const store: {
        plugins: Record<string, Plugin>
        setPluginStatus: jest.Mock
        setPluginError: jest.Mock
      } = {
        plugins: { p: mkPlugin("p", "enabled", { idleSuspend: true }) },
        setPluginStatus: jest.fn((id: string, s: Plugin["status"]) => {
          store.plugins[id].status = s
        }),
        setPluginError: jest.fn(),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const internals = manager as unknown as {
        unregisterPluginContributions: (id: string) => Promise<void>
        deactivatePluginRuntime: (id: string, opts?: unknown) => Promise<void>
        syncBackendStatus: (id: string, status: string) => Promise<void>
        recordPluginVerification: (id: string, input: unknown) => void
      }
      jest.spyOn(internals, "unregisterPluginContributions").mockResolvedValue(undefined)
      jest.spyOn(internals, "deactivatePluginRuntime").mockResolvedValue(undefined)
      jest.spyOn(internals, "syncBackendStatus").mockResolvedValue(undefined)
      jest.spyOn(internals, "recordPluginVerification").mockReturnValue(undefined)
      const hooks = getPluginLifecycleHooks()
      const suspendSpy = jest.spyOn(hooks, "dispatchOnSuspend").mockResolvedValue(undefined)

      await manager.suspendPlugin("p")

      expect(suspendSpy).toHaveBeenCalledWith("p")
      expect(store.plugins.p.status).toBe("suspended")
      suspendSpy.mockRestore()
    })

    it("resumePlugin reloads, re-registers, and fires onResume", async () => {
      const store: {
        plugins: Record<string, Plugin>
        setPluginStatus: jest.Mock
        setPluginError: jest.Mock
      } = {
        plugins: { p: mkPlugin("p", "suspended", { idleSuspend: true }) },
        setPluginStatus: jest.fn((id: string, s: Plugin["status"]) => {
          store.plugins[id].status = s
        }),
        setPluginError: jest.fn(),
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const internals = manager as unknown as {
        registerPluginContributions: (id: string) => Promise<void>
        syncBackendStatus: (id: string, status: string) => Promise<void>
        recordPluginVerification: (id: string, input: unknown) => void
      }
      jest.spyOn(manager, "loadPlugin").mockResolvedValue(undefined)
      jest.spyOn(internals, "registerPluginContributions").mockResolvedValue(undefined)
      jest.spyOn(internals, "syncBackendStatus").mockResolvedValue(undefined)
      jest.spyOn(internals, "recordPluginVerification").mockReturnValue(undefined)
      const hooks = getPluginLifecycleHooks()
      const resumeSpy = jest.spyOn(hooks, "dispatchOnResume").mockResolvedValue(undefined)

      await manager.resumePlugin("p")

      expect(resumeSpy).toHaveBeenCalledWith("p")
      expect(store.plugins.p.status).toBe("enabled")
      resumeSpy.mockRestore()
    })

    it("suspendIdlePlugins suspends only enabled, opted-in, idle plugins", async () => {
      const now = 2_000_000_000_000
      const idleMs = 31 * 60 * 1000
      const store = {
        plugins: {
          idle: mkPlugin("idle", "enabled", { idleSuspend: true }, { lastUsedAt: now - idleMs }),
          fresh: mkPlugin("fresh", "enabled", { idleSuspend: true }, { lastUsedAt: now - 1000 }),
          notOptedIn: mkPlugin("notOptedIn", "enabled", {}, { lastUsedAt: now - idleMs }),
          disabledIdle: mkPlugin(
            "disabledIdle",
            "disabled",
            { idleSuspend: true },
            { lastUsedAt: now - idleMs }
          ),
        },
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const suspendSpy = jest.spyOn(manager, "suspendPlugin").mockResolvedValue(undefined)

      const suspended = await manager.suspendIdlePlugins(now)

      expect(suspended).toEqual(["idle"])
      expect(suspendSpy).toHaveBeenCalledTimes(1)
      expect(suspendSpy).toHaveBeenCalledWith("idle", "idle")
      suspendSpy.mockRestore()
    })

    it("startIdleSweep starts a timer only when a plugin opts in; stopIdleSweep clears it", () => {
      jest.useFakeTimers()
      try {
        const store = {
          plugins: { p: mkPlugin("p", "enabled", { idleSuspend: true }, { lastUsedAt: 0 }) },
        }
        mockGetState.mockReturnValue(store)
        const manager = new PluginManager({ pluginDirectory: "/plugins" })
        const sweepSpy = jest.spyOn(manager, "suspendIdlePlugins").mockResolvedValue([])

        manager.startIdleSweep()
        // Calling again is idempotent (no second timer).
        manager.startIdleSweep()
        jest.advanceTimersByTime(5 * 60 * 1000)
        expect(sweepSpy).toHaveBeenCalledTimes(1)

        manager.stopIdleSweep()
        sweepSpy.mockClear()
        jest.advanceTimersByTime(10 * 60 * 1000)
        expect(sweepSpy).not.toHaveBeenCalled()
        sweepSpy.mockRestore()
      } finally {
        jest.useRealTimers()
      }
    })

    it("startIdleSweep does nothing when no plugin opts in", () => {
      jest.useFakeTimers()
      try {
        const store = { plugins: { p: mkPlugin("p", "enabled") } }
        mockGetState.mockReturnValue(store)
        const manager = new PluginManager({ pluginDirectory: "/plugins" })
        const sweepSpy = jest.spyOn(manager, "suspendIdlePlugins").mockResolvedValue([])

        manager.startIdleSweep()
        jest.advanceTimersByTime(10 * 60 * 1000)
        expect(sweepSpy).not.toHaveBeenCalled()
        manager.stopIdleSweep()
        sweepSpy.mockRestore()
      } finally {
        jest.useRealTimers()
      }
    })

    it("wakes a suspended plugin on ANY activation event, even one it never declared", async () => {
      // A plugin that declared only `startup` and then idle-suspended must
      // still wake on an onTool event — suspension is internal, not a declared-
      // activation gate.
      const store = {
        plugins: {
          // builtin source → bypasses the frontend-trust gate so the test
          // isolates the suspended-wake bypass, not the trust check.
          p: mkPlugin(
            "p",
            "suspended",
            { activationEvents: ["startup"] },
            {
              source: "builtin" as never,
            }
          ),
        },
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const resumeSpy = jest.spyOn(manager, "resumePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("onTool:some_tool")

      expect(resumeSpy).toHaveBeenCalledWith("p", "activation:onTool:some_tool")
      resumeSpy.mockRestore()
    })

    it("does NOT lazy-activate a DISABLED plugin for an undeclared event", async () => {
      // The suspended-wake bypass must not leak to disabled plugins — those
      // still lazy-activate only for their declared events.
      const store = {
        plugins: {
          p: mkPlugin("p", "disabled", { activationEvents: ["onCommand:foo"] }),
        },
      }
      mockGetState.mockReturnValue(store)
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      const resumeSpy = jest.spyOn(manager, "resumePlugin").mockResolvedValue(undefined)
      const enableSpy = jest.spyOn(manager, "enablePlugin").mockResolvedValue(undefined)

      await manager.handleActivationEvent("onTool:some_tool")

      expect(resumeSpy).not.toHaveBeenCalled()
      expect(enableSpy).not.toHaveBeenCalled()
      resumeSpy.mockRestore()
      enableSpy.mockRestore()
    })

    it("recordPluginToolUse refreshes the plugin's idle-suspend clock", () => {
      const updateLastUsedAt = jest.fn()
      mockGetState.mockReturnValue({ plugins: {}, updateLastUsedAt })
      const manager = new PluginManager({ pluginDirectory: "/plugins" })
      manager.recordPluginToolUse("p")
      expect(updateLastUsedAt).toHaveBeenCalledWith("p")
    })
  })
})

describe("toClonableManifest", () => {
  it("strips function-valued members so the manifest is structured-clone-safe", () => {
    const write = jest.fn()
    const manifest = {
      id: "cognia-agent-team-examples",
      name: "Agent Team Examples",
      version: "1.0.0",
      sharedMemoryAdapters: [
        { id: "demo", name: "In-Memory (demo)", write, read: () => undefined },
      ],
    } as unknown as PluginManifest

    const clonable = toClonableManifest(manifest)

    // Serializable metadata survives…
    expect(clonable.id).toBe("cognia-agent-team-examples")
    const adapters = (
      clonable as unknown as { sharedMemoryAdapters: Array<Record<string, unknown>> }
    ).sharedMemoryAdapters
    expect(adapters[0].id).toBe("demo")
    expect(adapters[0].name).toBe("In-Memory (demo)")
    // …but the function members are gone, so structuredClone no longer throws.
    expect(adapters[0].write).toBeUndefined()
    expect(adapters[0].read).toBeUndefined()
    expect(() => structuredClone(clonable)).not.toThrow()
  })

  it("returns a manifest with no functions unchanged in shape", () => {
    const manifest = {
      id: "plain",
      name: "Plain",
      version: "0.1.0",
      capabilities: ["tools"],
    } as unknown as PluginManifest

    expect(toClonableManifest(manifest)).toEqual(manifest)
  })
})

// ── W3.2: chat-intercept hook permission gate ────────────────────────────────
describe("chat-intercept hook permission gate", () => {
  type WithValidate = { validateHookDeclarations: (id: string, hooks: unknown) => void }
  const mockGetStateW32 = usePluginStore.getState as unknown as jest.Mock

  const seed = (permissions: string[]) => {
    mockGetStateW32.mockReturnValue({
      plugins: {
        wiretap: { manifest: { id: "wiretap", permissions }, status: "enabled" },
      },
    })
  }

  const validate = (hooks: Record<string, unknown>) => {
    const manager = new PluginManager({ pluginDirectory: "/plugins" })
    ;(manager as unknown as WithValidate).validateHookDeclarations("wiretap", hooks)
  }

  it.each([
    "onUserPromptSubmit",
    "onPreToolUse",
    "onPostToolUse",
    "onMessageSend",
    "onMessageReceive",
  ])("refuses %s without hooks:chat-intercept", (hookName) => {
    seed([])
    expect(() => validate({ [hookName]: jest.fn() })).toThrow(/hooks:chat-intercept/)
  })

  it("accepts intercept hooks when hooks:chat-intercept is declared", () => {
    seed(["hooks:chat-intercept"])
    expect(() => validate({ onPreToolUse: jest.fn(), onUserPromptSubmit: jest.fn() })).not.toThrow()
  })

  it("leaves non-intercept hooks ungated", () => {
    seed([])
    expect(() => validate({ onLoad: jest.fn(), onEnable: jest.fn() })).not.toThrow()
  })
})

// ── W6.4: per-plugin lifecycle serialization ─────────────────────────────────
describe("lifecycle serialization (W6.4)", () => {
  type WithLock = {
    withLifecycleLock: <T>(pluginId: string, fn: () => Promise<T>) => Promise<T>
  }
  const lockOf = (m: PluginManager) =>
    (m as unknown as WithLock).withLifecycleLock.bind(m as unknown as WithLock)

  it("serializes overlapping transitions for the same plugin", async () => {
    const withLock = lockOf(new PluginManager({ pluginDirectory: "/plugins" }))
    const order: string[] = []
    const a = withLock("p", async () => {
      order.push("a-start")
      // Microtask deferral (not a real timer): keeps the interleaving window
      // open without letting unrelated detached rejections land in this test.
      for (let i = 0; i < 5; i++) await Promise.resolve()
      order.push("a-end")
    })
    const b = withLock("p", async () => {
      order.push("b-start")
      order.push("b-end")
    })
    await Promise.all([a, b])
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"])
  })

  it("keeps different plugins concurrent", async () => {
    const withLock = lockOf(new PluginManager({ pluginDirectory: "/plugins" }))
    const order: string[] = []
    let releaseA!: () => void
    const gate = new Promise<void>((r) => {
      releaseA = r
    })
    const a = withLock("p1", async () => {
      order.push("p1-start")
      await gate
      order.push("p1-end")
    })
    const b = withLock("p2", async () => {
      order.push("p2-done")
    })
    await b
    expect(order).toEqual(["p1-start", "p2-done"])
    releaseA()
    await a
  })

  it("a rejected transition does not wedge the queue", async () => {
    const withLock = lockOf(new PluginManager({ pluginDirectory: "/plugins" }))
    await expect(
      withLock("p", async () => {
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    await expect(withLock("p", async () => "next")).resolves.toBe("next")
  })
})
