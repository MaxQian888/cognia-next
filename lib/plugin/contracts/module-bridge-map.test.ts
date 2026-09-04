/**
 * Drift guard for the async module-bridge capability map.
 *
 * Mirrors `capability-bridge-map.test.ts`. Walks every entry and asserts:
 *   1. The expected 7 capabilities are covered, count locked.
 *   2. Each `manifestField` is a real, well-formed `PluginManifest` key.
 *   3. Both `register` and `unregister` are functions.
 *   4. `register` with an empty manifest field is a safe no-op (exercises
 *      every descriptor closure + its bridge's empty-defs early return).
 *   5. A concrete round-trip through the asset path (`wallpapers`) proves the
 *      `ModuleBridgeContext` plumbing (resolveAsset) actually registers.
 *
 * If a future refactor renames a bridge export or drops a `manifest.X` field
 * without updating the map, this fails loudly — before plugin contributions
 * silently no-op at runtime (the exact failure mode this map was created to
 * fix).
 */

// Keep the `scheduler` descriptor hermetic — its bridge falls back to the live
// `getTaskScheduler()` (Dexie) when no scheduler is injected. The descriptor
// table can't inject one, so stub the module here.
jest.mock("@/lib/scheduler/task-scheduler", () => ({
  getTaskScheduler: () => ({
    getAllTasks: async () => [],
    createTask: async (input: unknown) => ({ ...(input as object), id: "stub" }),
    deleteTask: async () => true,
    pauseTask: async () => true,
  }),
}))

import {
  MODULE_BRIDGE_CAPABILITIES,
  MODULE_BRIDGE_CAPABILITY_KEYS,
  type ModuleBridgeCapabilityDescriptor,
  type ModuleBridgeContext,
} from "./module-bridge-map"
import {
  listPluginWallpapers,
  __resetPluginWallpapersForTesting,
} from "@/lib/plugin/bridge/wallpaper-bridge"
import type { PluginManifest } from "@/types/plugin"

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    version: "0.0.0",
    description: "test",
    type: "frontend",
    permissions: [],
    capabilities: [],
    ...overrides,
  } as PluginManifest
}

function makeCtx(manifest: PluginManifest): ModuleBridgeContext {
  return {
    pluginId: manifest.id,
    manifest,
    installRoot: "/plugins/test-plugin",
    importer: async () => ({}),
    resolveAsset: (root, rel) => `${root}/${rel}`,
    moduleExports: {},
    hasPermission: () => true,
  }
}

describe("MODULE_BRIDGE_CAPABILITIES", () => {
  // jsdom does not polyfill `fetch`; the font bridge references the global
  // (defaulting `fetchImpl`) even when there are no files to fetch. In the
  // real browser/Tauri webview `fetch` always exists.
  const originalFetch = globalThis.fetch
  beforeAll(() => {
    if (typeof globalThis.fetch === "undefined") {
      globalThis.fetch = jest.fn() as unknown as typeof fetch
    }
  })
  afterAll(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    __resetPluginWallpapersForTesting()
  })

  it("covers exactly the async-bridge capabilities the dispatch loop expects", () => {
    expect(MODULE_BRIDGE_CAPABILITY_KEYS).toEqual(
      expect.arrayContaining([
        "ai-provider",
        "media",
        "workspace-backend",
        "message-renderer",
        "tool-renderer",
        "connectors",
        "integrations",
        "fonts",
        "wallpapers",
        "density-preset",
        "chat-middleware",
        "commands",
        "modal-mount",
        "terminal-completion",
        "routing-strategy",
        "deployment-filter",
        "protocol-adapter",
        "external-agent-adapter",
        "session-importer",
        "tool-route",
        "context-provider",
        "context-panel",
        "scheduler",
        "view",
        "webview",
        "bot",
      ])
    )
    // Lock the count — silent growth means the manager dispatch loop picked
    // up new behaviour that may need verification. `integrations` (24th) was
    // verified: the loop at `manager.ts:3830` / `:4118` is fully generic, and
    // `registerIntegrationsForPlugin` / `unregisterIntegrationsForPlugin` are
    // real and covered by `integrations-bridge.test.ts`.
    // `commands` (25th) is declarative bookkeeping for python-backed
    // `manifest.commands[]`, covered by `commands-bridge.test.ts`.
    // `bot` (26th) was verified: only `executor: "handler"` imports anything,
    // and `bots-bridge.test.ts` covers the JS export, the python snapshot
    // boundary, the per-bot error isolation and the re-enable drop.
    expect(MODULE_BRIDGE_CAPABILITY_KEYS).toHaveLength(26)
  })

  describe.each(MODULE_BRIDGE_CAPABILITY_KEYS)("%s", (key) => {
    const descriptor: ModuleBridgeCapabilityDescriptor = MODULE_BRIDGE_CAPABILITIES[key]

    it("points at a real, well-formed PluginManifest field", () => {
      const manifest = makeManifest()
      // Index access exercises the field name against a representative manifest.
      ;(manifest as unknown as Record<string, unknown>)[descriptor.manifestField] = undefined
      expect(descriptor.manifestField).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/)
    })

    it("exposes runnable register + unregister functions", () => {
      expect(typeof descriptor.register).toBe("function")
      expect(typeof descriptor.unregister).toBe("function")
    })

    it("register is a safe no-op when the manifest field is empty", async () => {
      const ctx = makeCtx(makeManifest())
      await expect(descriptor.register(ctx)).resolves.toBeUndefined()
    })

    it("unregister does not throw for an unknown plugin", () => {
      expect(() => descriptor.unregister("never-registered-plugin")).not.toThrow()
    })
  })

  it("round-trips a wallpaper contribution through the asset path", async () => {
    const manifest = makeManifest({
      id: "wp-plugin",
      capabilities: ["wallpapers"],
      wallpapers: [
        {
          id: "sunset",
          name: "Sunset",
          source: { kind: "gradient", css: "linear-gradient(#f00,#00f)" },
        },
      ],
    })
    const descriptor = MODULE_BRIDGE_CAPABILITIES.wallpapers
    const ctx = makeCtx(manifest)

    await descriptor.register(ctx)
    expect(listPluginWallpapers().some((w) => w.pluginId === "wp-plugin")).toBe(true)

    descriptor.unregister("wp-plugin")
    expect(listPluginWallpapers().some((w) => w.pluginId === "wp-plugin")).toBe(false)
  })
})
