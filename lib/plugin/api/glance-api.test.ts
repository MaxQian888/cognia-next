/**
 * Tests for `ctx.glance` (ADR-0225 §6): capability gating, local-id mapping
 * onto the renderer's plugin module registry, author errors, visibility and
 * lifecycle tracking.
 */

import { createGlanceAPI } from "./glance-api"
import { GlancePluginModuleError, glancePluginModules } from "@/lib/glance/plugin-registry"
import type { GlancePluginModuleData, GlancePluginModuleDef } from "@/lib/glance/plugin-data"
import type { PluginGlanceModuleData, PluginManifestGlanceModuleDef } from "@/types/plugin"
import { pluginEntryId } from "@/types/glance/layout"

jest.mock("@cognia/logging", () => {
  const logger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() }
  return { loggers: new Proxy({}, { get: () => logger }) }
})
jest.mock("../contracts/diagnostics-store", () => ({
  recordSilentFailure: jest.fn(),
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { recordSilentFailure } = require("../contracts/diagnostics-store") as {
  recordSilentFailure: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loggers } = require("@cognia/logging") as { loggers: { plugin: { warn: jest.Mock } } }

// What an author hands over must stay assignable to the host's shapes: a
// drift fails typecheck here before it reaches a plugin.
const authorData: PluginGlanceModuleData = { stats: [{ label: "a", value: "1", tone: "ok" }] }
const hostData: GlancePluginModuleData = authorData
const authorDef: PluginManifestGlanceModuleDef = { id: "m", title: "M", sizes: ["compact"] }
const hostDef: GlancePluginModuleDef = authorDef
void hostData
void hostDef

const PLUGIN = "com.example.glance"

afterEach(() => {
  glancePluginModules.unregisterAllByPlugin(PLUGIN)
  glancePluginModules.setOnScreen("test", null)
  recordSilentFailure.mockReset()
  loggers.plugin.warn.mockReset()
})

describe("createGlanceAPI", () => {
  it("is a warn-once no-op without the glance capability", () => {
    const api = createGlanceAPI({ pluginId: PLUGIN, capabilities: ["tray"] })
    const dispose = api.register({ id: "builds", title: "Builds" })
    api.update("builds", { summary: "x" })
    const handler = jest.fn()
    const unsubscribe = api.onVisibilityChange("builds", handler)

    expect(glancePluginModules.get(pluginEntryId(PLUGIN, "builds"))).toBeNull()
    expect(handler).not.toHaveBeenCalled()
    expect(loggers.plugin.warn).toHaveBeenCalledTimes(1)
    expect(() => {
      dispose()
      unsubscribe()
    }).not.toThrow()
  })

  it("registers by local id and the disposer removes the module", () => {
    const api = createGlanceAPI({ pluginId: PLUGIN, capabilities: ["glance"] })
    const dispose = api.register({ id: "builds", title: "Builds", icon: "Hammer" })

    const entry = glancePluginModules.get(pluginEntryId(PLUGIN, "builds"))
    expect(entry).toMatchObject({ pluginId: PLUGIN, def: { id: "builds", title: "Builds" } })

    dispose()
    expect(glancePluginModules.get(pluginEntryId(PLUGIN, "builds"))).toBeNull()
    // Idempotent.
    expect(() => dispose()).not.toThrow()
  })

  it("publishes sanitized data by local id and clears it with null", () => {
    const api = createGlanceAPI({ pluginId: PLUGIN, capabilities: ["glance"] })
    api.register({ id: "builds", title: "Builds" })
    const entryId = pluginEntryId(PLUGIN, "builds")

    api.update("builds", {
      stats: [{ label: "Passing", value: "12", tone: "ok" }],
      actions: [{ id: "run", label: "Run", command: "runBuild" }],
      rows: [{ id: "main", label: "main", action: "run" }],
    })
    expect(glancePluginModules.dataOf(entryId)?.data).toEqual({
      stats: [{ label: "Passing", value: "12", tone: "ok" }],
      actions: [{ id: "run", label: "Run", command: "runBuild" }],
      rows: [{ id: "main", label: "main", action: "run" }],
    })

    api.update("builds", null)
    expect(glancePluginModules.dataOf(entryId)).toBeNull()
  })

  it("surfaces author errors from the registry", () => {
    const api = createGlanceAPI({ pluginId: PLUGIN, capabilities: ["glance"] })

    expect(() => api.register({ id: "bad id!", title: "Bad" })).toThrow(GlancePluginModuleError)
    expect(() => api.register({ id: "untitled", title: "" })).toThrow(GlancePluginModuleError)
    expect(() => api.update("never-declared", { summary: "x" })).toThrow(GlancePluginModuleError)
    expect(() => api.onVisibilityChange("bad id!", () => {})).toThrow(GlancePluginModuleError)
    expect(() =>
      api.onVisibilityChange("builds", "nope" as unknown as (visible: boolean) => void)
    ).toThrow(TypeError)
  })

  it("enforces the per-plugin module limit", () => {
    const api = createGlanceAPI({ pluginId: PLUGIN, capabilities: ["glance"] })
    for (let i = 0; i < 8; i += 1) api.register({ id: `m${i}`, title: `M${i}` })
    expect(() => api.register({ id: "m8", title: "M8" })).toThrow(/at most 8/)
  })

  it("restores the manifest declaration when a runtime override is disposed", () => {
    // What the overlay bridge does for `manifest.glanceModules[]`.
    glancePluginModules.register(PLUGIN, { id: "builds", title: "Builds (manifest)" })
    const api = createGlanceAPI({ pluginId: PLUGIN, capabilities: ["glance"] })
    const entryId = pluginEntryId(PLUGIN, "builds")

    const dispose = api.register({ id: "builds", title: "Builds (runtime)" })
    api.update("builds", { summary: "kept" })
    expect(glancePluginModules.get(entryId)?.def.title).toBe("Builds (runtime)")

    dispose()
    expect(glancePluginModules.get(entryId)?.def.title).toBe("Builds (manifest)")
    expect(glancePluginModules.dataOf(entryId)?.data).toEqual({ summary: "kept" })
  })

  it("lets only the latest registration of an id remove it", () => {
    const api = createGlanceAPI({ pluginId: PLUGIN, capabilities: ["glance"] })
    const entryId = pluginEntryId(PLUGIN, "builds")
    const first = api.register({ id: "builds", title: "First" })
    const second = api.register({ id: "builds", title: "Second" })

    first()
    expect(glancePluginModules.get(entryId)?.def.title).toBe("Second")
    second()
    expect(glancePluginModules.get(entryId)).toBeNull()
  })

  it("does not resurrect a module after the plugin was torn down", () => {
    glancePluginModules.register(PLUGIN, { id: "builds", title: "Manifest" })
    const api = createGlanceAPI({ pluginId: PLUGIN, capabilities: ["glance"] })
    const dispose = api.register({ id: "builds", title: "Runtime" })

    // The disable teardown runs before the ledger sweep.
    glancePluginModules.unregisterAllByPlugin(PLUGIN)
    dispose()
    expect(glancePluginModules.get(pluginEntryId(PLUGIN, "builds"))).toBeNull()
  })

  it("reports visibility at once and on change, and isolates a throwing handler", () => {
    const api = createGlanceAPI({ pluginId: PLUGIN, capabilities: ["glance"] })
    api.register({ id: "builds", title: "Builds" })
    const handler = jest.fn()
    const unsubscribe = api.onVisibilityChange("builds", handler)
    expect(handler).toHaveBeenLastCalledWith(false)

    glancePluginModules.setOnScreen("test", [pluginEntryId(PLUGIN, "builds")])
    expect(handler).toHaveBeenLastCalledWith(true)

    unsubscribe()
    glancePluginModules.setOnScreen("test", null)
    expect(handler).toHaveBeenCalledTimes(2)

    const throwing = jest.fn(() => {
      throw new Error("boom")
    })
    expect(() => api.onVisibilityChange("builds", throwing)).not.toThrow()
    expect(recordSilentFailure).toHaveBeenCalledWith(
      PLUGIN,
      expect.objectContaining({ site: "glance.onVisibilityChange" }),
      expect.any(Error)
    )
  })

  it("enrols every disposer in the plugin's lifecycle scope", () => {
    const tracked: Array<{ label: string; dispose: () => void }> = []
    const api = createGlanceAPI({
      pluginId: PLUGIN,
      capabilities: ["glance"],
      track: (dispose, label) => {
        tracked.push({ label, dispose })
        return dispose
      },
    })
    api.register({ id: "builds", title: "Builds" })
    const handler = jest.fn()
    api.onVisibilityChange("builds", handler)

    expect(tracked.map((t) => t.label)).toEqual([
      "ctx.glance.register:builds",
      "ctx.glance.onVisibilityChange:builds",
    ])

    // The scope sweep (plugin disabled) releases them.
    for (const t of tracked) t.dispose()
    expect(glancePluginModules.get(pluginEntryId(PLUGIN, "builds"))).toBeNull()
    glancePluginModules.setOnScreen("test", [pluginEntryId(PLUGIN, "builds")])
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
