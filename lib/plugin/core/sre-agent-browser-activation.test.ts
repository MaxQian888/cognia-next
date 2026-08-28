/** @jest-environment jsdom */
/**
 * Does the incident panel actually reach the right-hand workbench in a browser
 * tab?
 *
 * Every step between "the plugin is in the bundle" and "the rail button exists"
 * is a separate gate — the runtime-profile block, the builtin trust rule, the
 * startup activation spec, the API-permission grant, and the panel registry —
 * and each one fails silently. Booting the real manager against the real
 * manifest is the only thing that proves the chain end to end.
 *
 * Harness mirrors `builtin-contributions-flow.test.ts` next door.
 *
 * Lives here, not under `plugins/sre-agent/`, because it is a test of the HOST:
 * it boots the real `PluginManager` and drives the signature verifier, the
 * permission guard and the panel registry. A plugin's own suite must be
 * runnable against the published SDK surface alone — this one cannot be, and
 * pretending otherwise is what kept those host-private imports alive.
 */

import "fake-indexeddb/auto"

import { invoke } from "@tauri-apps/api/core"
import { PluginManager } from "@/lib/plugin/core/manager"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { getPluginSignatureVerifier } from "@/lib/plugin/security/signature"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { canUseTauriInvoke } from "@/lib/native/utils"
import type { ContextResource } from "@/types/context-workbench"
import type { Plugin, PluginManifest } from "@/types/plugin"
import { PANEL_ACTIVITY, PANEL_FULL_ID, PLUGIN_ID } from "@/plugins/sre-agent/src/ids"

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/stores/plugin-runtime", () => ({ usePluginStore: { getState: jest.fn() } }))
jest.mock("@/lib/plugin/security/signature", () => ({ getPluginSignatureVerifier: jest.fn() }))
jest.mock("@/lib/plugin/security/permission-guard", () => ({
  getPermissionGuard: jest.fn(),
  createGuardedAPI: jest.fn((_pluginId: string, api: unknown) => api),
}))
jest.mock("@/lib/native/utils", () => {
  const actual = jest.requireActual("@/lib/native/utils")
  return { ...actual, canUseTauriInvoke: jest.fn(() => false), isTauri: jest.fn(() => false) }
})
jest.mock("@/lib/chat/slash-command-registry", () => ({
  getSlashCommand: jest.fn(),
  registerSlashCommand: jest.fn(),
  unregisterSlashCommand: jest.fn(),
}))
jest.mock("@/lib/plugin/dexie/bridge", () => ({
  applyPluginTables: jest.fn(async () => undefined),
  removePluginTables: jest.fn(async () => undefined),
}))

import { usePluginStore } from "@/stores/plugin-runtime"

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

const SESSION: ContextResource = {
  kind: "session",
  sessionId: "sess_1",
  capabilities: [],
} as unknown as ContextResource

describe("sre-agent in a browser tab", () => {
  const mockGetState = usePluginStore.getState as unknown as jest.Mock
  const mockInvoke = invoke as jest.MockedFunction<typeof invoke>

  beforeEach(() => {
    jest.clearAllMocks()
    contextPanelRegistry.unregisterPlugin(PLUGIN_ID)
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
      check: jest.fn(() => true),
      getPluginPermissions: jest.fn(() => [] as string[]),
    })
    ;(canUseTauriInvoke as jest.Mock).mockReturnValue(false)
    mockInvoke.mockResolvedValue(undefined)
  })

  it("registers the incident panel for a session resource on the browser profile", async () => {
    const store = makeStore()
    mockGetState.mockReturnValue(store)

    const manager = new PluginManager({ pluginDirectory: "", runtimeProfile: "browser" })
    await manager.scanPlugins()
    await manager.enablePlugin(PLUGIN_ID)

    expect((store.setPluginError as jest.Mock).mock.calls.filter((c) => c[1] != null)).toEqual([])
    expect(store.plugins[PLUGIN_ID]?.status).toBe("enabled")

    const resolved = contextPanelRegistry.resolve(SESSION)
    expect(resolved.map((panel) => panel.id)).toContain(PANEL_FULL_ID)

    const panel = resolved.find((entry) => entry.id === PANEL_FULL_ID)
    expect(panel).toMatchObject({ activity: PANEL_ACTIVITY, pluginId: PLUGIN_ID })

    // Its own rail button, not a seventh tab inside `inspect`: the rail groups
    // by activity, so sharing one would bury the panel behind an overflow.
    expect(contextPanelRegistry.listActivities()).toContain(PANEL_ACTIVITY)
    expect(resolved.filter((entry) => entry.activity === PANEL_ACTIVITY)).toHaveLength(1)
  })
})
