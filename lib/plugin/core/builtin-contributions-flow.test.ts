/** @jest-environment jsdom */
/**
 * End-to-end regression for built-in plugin contribution registration.
 *
 * Guards the two wiring bugs that left every declarative builtin
 * contribution dormant:
 *  1. Discovery used the thin `plugin.json` manifest instead of the module
 *     definition's manifest, so the OVERLAY_REGISTRY dispatch loop and the
 *     dexie/i18n enable steps saw no `workflowTemplates` / `skills` /
 *     `mcpServerPresets` / `dexie` fields (fixed by `builtinManifest` in
 *     `browser-builtin-registry.ts`).
 *  2. `scanPlugins()` on the tauri profile only invoked the (nonexistent)
 *     `plugin_scan_directory` command, so built-ins were never discovered
 *     on desktop (fixed by running the builtin registry walk on both
 *     profiles).
 *
 * Uses the real zhihu-content-pipeline plugin as the probe because it
 * exercises every contribution lane at once (template + custom node +
 * character pack + skills + MCP presets + dexie-gated imperative wiring).
 */

import "fake-indexeddb/auto"

import { invoke } from "@tauri-apps/api/core"
import { PluginManager } from "./manager"
import type { Plugin, PluginManifest } from "@/types/plugin"
import { getPluginSignatureVerifier } from "@/lib/plugin/security/signature"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { canUseTauriInvoke } from "@/lib/native/utils"
import {
  listWorkflowTemplateIds,
  getWorkflowTemplateWarnings,
  __resetWorkflowTemplatesForTesting,
} from "@/lib/plugin/registries/workflow-template-registry"
import { getPluginCatalogSnapshot } from "@/lib/workflow/nodes/catalog"
import { listCharacterPackIds } from "@/lib/plugin/registries/character-pack-registry"
import { listSkillIds } from "@/lib/plugin/registries/skill-registry"
import { listMcpServerPresetIds } from "@/lib/plugin/registries/mcp-server-preset-registry"
import { getBrowserBuiltinRegistryEntry } from "./browser-builtin-registry"
import zhihuPluginJson from "@/plugins/zhihu-content-pipeline/plugin.json"

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
  createGuardedAPI: jest.fn((_pluginId: string, api: unknown) => api),
}))

jest.mock("@/lib/native/utils", () => {
  const actual = jest.requireActual("@/lib/native/utils")
  return {
    ...actual,
    canUseTauriInvoke: jest.fn(() => false),
    isTauri: jest.fn(() => false),
  }
})

jest.mock("@/lib/chat/slash-command-registry", () => ({
  getSlashCommand: jest.fn(),
  registerSlashCommand: jest.fn(),
  unregisterSlashCommand: jest.fn(),
}))

// IndexedDB isn't available here; the dexie bridge would throw on
// `applyPluginTables` during enable.
jest.mock("@/lib/plugin/dexie/bridge", () => ({
  applyPluginTables: jest.fn(async () => undefined),
  removePluginTables: jest.fn(async () => undefined),
}))

import { usePluginStore } from "@/stores/plugin-runtime"

const PLUGIN_ID = "zhihu-content-pipeline"

function makeStore() {
  const store = {
    plugins: {} as Record<string, Plugin>,
    rememberedPermissions: {} as Record<string, Record<string, string>>,
    discoverPlugin: jest.fn(
      (
        manifest: PluginManifest,
        source: string,
        path: string,
        options?: Record<string, unknown>
      ) => {
        store.plugins[manifest.id] = {
          manifest,
          status: store.plugins[manifest.id]?.status ?? "discovered",
          source: source as never,
          path,
          descriptor: options?.descriptor as Plugin["descriptor"],
          config: {},
        } as Plugin
      }
    ),
    installPlugin: jest.fn(async (pluginId: string) => {
      store.plugins[pluginId] = { ...store.plugins[pluginId], status: "installed" } as Plugin
    }),
    loadPlugin: jest.fn(async (pluginId: string) => {
      store.plugins[pluginId] = { ...store.plugins[pluginId], status: "loaded" } as Plugin
    }),
    enablePlugin: jest.fn(async (pluginId: string) => {
      store.plugins[pluginId] = { ...store.plugins[pluginId], status: "enabled" } as Plugin
    }),
    registerPluginHooks: jest.fn(),
    registerPluginTool: jest.fn(),
    registerPluginCommand: jest.fn(),
    registerPluginMode: jest.fn(),
    setPluginError: jest.fn(),
    setPluginVerificationSnapshot: jest.fn(),
    emitEvent: jest.fn(),
  }
  return store
}

describe("builtin plugin contribution flow", () => {
  const mockGetState = usePluginStore.getState as unknown as jest.Mock
  const mockInvoke = invoke as jest.MockedFunction<typeof invoke>

  beforeEach(() => {
    jest.clearAllMocks()
    __resetWorkflowTemplatesForTesting()
    ;(getPluginSignatureVerifier as jest.Mock).mockReturnValue({
      verify: jest.fn().mockResolvedValue({ verified: true }),
      getConfig: jest.fn().mockReturnValue({ requireSignatures: false, allowUntrusted: true }),
    })
    ;(getPermissionGuard as jest.Mock).mockReturnValue({
      registerPlugin: jest.fn(),
      unregisterPlugin: jest.fn(),
      revokeAll: jest.fn(),
      grant: jest.fn(),
      revoke: jest.fn(),
      getPluginPermissions: jest.fn(() => [] as string[]),
    })
    ;(canUseTauriInvoke as jest.Mock).mockReturnValue(false)
    mockInvoke.mockResolvedValue(undefined)
  })

  it("hydrates the discovery manifest with the module manifest's contribution arrays", () => {
    const entry = getBrowserBuiltinRegistryEntry(PLUGIN_ID)
    expect(entry).toBeDefined()
    const manifest = entry!.manifest as PluginManifest & {
      workflowTemplates?: unknown[]
      skills?: unknown[]
      mcpServerPresets?: unknown[]
    }
    // plugin.json identity fields survive the merge…
    expect(manifest.id).toBe(PLUGIN_ID)
    expect(manifest.description).toBeTruthy()
    // Every activation event plugin.json declares survives the merge — the
    // module manifest omits the field, so it must not blank it out. Compared
    // against the JSON itself rather than a hard-coded list, which went stale
    // the moment the plugin declared its `/zhihu` command
    // (`onCommand:zhihu`).
    expect(manifest.activationEvents).toEqual(zhihuPluginJson.activationEvents)
    expect(manifest.activationEvents).toContain("startup")
    // …and the module manifest's declarative arrays ride along.
    expect(manifest.workflowTemplates?.length).toBe(1)
    expect(manifest.skills?.length).toBeGreaterThan(0)
    expect(manifest.mcpServerPresets?.length).toBeGreaterThan(0)
    expect(manifest.dexie).toBeDefined()
  })

  it("registers every declarative contribution lane when the builtin is enabled (browser profile)", async () => {
    const store = makeStore()
    mockGetState.mockReturnValue(store)

    const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "browser" })
    await manager.scanPlugins()
    await manager.enablePlugin(PLUGIN_ID)

    expect((store.setPluginError as jest.Mock).mock.calls.filter((c) => c[1] != null)).toEqual([])

    // Workflow template (overlay registry) — the import surface's source.
    expect(listWorkflowTemplateIds()).toContain("zhihu-topic-discovery")
    // The template's required custom node is in the catalog (dexie-gated
    // imperative registration ran), so no `requires` warnings remain.
    expect(getWorkflowTemplateWarnings("zhihu-topic-discovery")).toEqual([])
    expect(
      getPluginCatalogSnapshot().some((e) => (e.kind as string) === `${PLUGIN_ID}.save-topics`)
    ).toBe(true)
    // Sibling lanes registered from the same hydrated manifest.
    expect(listCharacterPackIds()).toContain("zhihu-roles")
    expect(listSkillIds().length).toBeGreaterThan(0)
    expect(listMcpServerPresetIds().length).toBeGreaterThan(0)
  })

  it("discovers built-ins on the tauri profile even when the directory scan fails", async () => {
    const store = makeStore()
    mockGetState.mockReturnValue(store)
    ;(canUseTauriInvoke as jest.Mock).mockReturnValue(true)
    // `plugin_scan_directory` does not exist as a Tauri command — simulate
    // the rejection the real bridge produces.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin_scan_directory") {
        throw new Error("command plugin_scan_directory not found")
      }
      return undefined
    })

    const manager = new PluginManager({
      pluginDirectory: "C:\\data\\cognia\\plugins",
      runtimeProfile: "tauri",
    })
    const discovered = await manager.scanPlugins()

    expect(discovered.some((p) => p.manifest.id === PLUGIN_ID)).toBe(true)
    expect(store.plugins[PLUGIN_ID]).toBeDefined()
  })
})
