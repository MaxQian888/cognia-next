import { GLANCE_PLUGIN_LIMITS } from "./plugin-data"
import { GlancePluginModuleError, GlancePluginModuleRegistry } from "./plugin-registry"

describe("GlancePluginModuleRegistry", () => {
  let registry: GlancePluginModuleRegistry

  beforeEach(() => {
    registry = new GlancePluginModuleRegistry()
  })

  it("declares a module under its entry id, sanitized", () => {
    const id = registry.register("com.ci", { id: "status", title: " CI " })
    expect(id).toBe("plugin:com.ci:status")
    expect(registry.catalog()).toEqual([
      {
        entryId: id,
        pluginId: "com.ci",
        def: {
          id: "status",
          title: "CI",
          sizes: ["compact", "standard"],
          platforms: ["desktop", "mobile"],
        },
      },
    ])
    expect(registry.get(id)?.pluginId).toBe("com.ci")
  })

  it("refuses a declaration that cannot be one, and a bad plugin id", () => {
    expect(() => registry.register("com.ci", { id: "bad id", title: "x" })).toThrow(
      GlancePluginModuleError
    )
    expect(() => registry.register("bad plugin", { id: "a", title: "x" })).toThrow(
      GlancePluginModuleError
    )
  })

  it("limits modules per plugin, but lets a module be re-declared", () => {
    for (let i = 0; i < GLANCE_PLUGIN_LIMITS.modulesPerPlugin; i += 1) {
      registry.register("p", { id: `m${i}`, title: "M" })
    }
    expect(() => registry.register("p", { id: "one-more", title: "M" })).toThrow(/at most/)
    expect(() => registry.register("p", { id: "m0", title: "Renamed" })).not.toThrow()
    expect(registry.get("plugin:p:m0")?.def.title).toBe("Renamed")
    expect(() => registry.register("other", { id: "m", title: "M" })).not.toThrow()
  })

  it("keeps data across a re-declaration", () => {
    registry.register("p", { id: "m", title: "M" })
    registry.update("p", "m", { summary: "hi" }, 5)
    registry.register("p", { id: "m", title: "M2" })
    expect(registry.dataOf("plugin:p:m")).toEqual({ data: { summary: "hi" }, updatedAt: 5 })
  })

  it("stores sanitized data and clears it with null", () => {
    registry.register("p", { id: "m", title: "M" })
    registry.update("p", "m", { summary: "x", junk: true }, 7)
    expect(registry.dataOf("plugin:p:m")).toEqual({ data: { summary: "x" }, updatedAt: 7 })
    registry.update("p", "m", null)
    expect(registry.dataOf("plugin:p:m")).toBeNull()
  })

  it("refuses data for a module that is not declared", () => {
    expect(() => registry.update("p", "ghost", { summary: "x" })).toThrow(/not declared/)
  })

  it("drops a module with its data, and every module of a plugin", () => {
    const a = registry.register("p", { id: "a", title: "A" })
    registry.register("p", { id: "b", title: "B" })
    const c = registry.register("q", { id: "c", title: "C" })
    registry.update("p", "a", { summary: "x" })
    expect(registry.unregister(a)).toBe(true)
    expect(registry.unregister(a)).toBe(false)
    expect(registry.dataOf(a)).toBeNull()
    registry.unregisterAllByPlugin("p")
    expect(registry.catalog().map((e) => e.entryId)).toEqual([c])
  })

  it("notifies subscribers and bumps its version on catalog and data changes", () => {
    const listener = jest.fn()
    const off = registry.subscribe(listener)
    const v0 = registry.getVersion()
    registry.register("p", { id: "m", title: "M" })
    registry.update("p", "m", { summary: "x" })
    registry.update("p", "m", null)
    registry.update("p", "m", null) // nothing to clear: no change
    expect(listener).toHaveBeenCalledTimes(3)
    expect(registry.getVersion()).toBe(v0 + 3)
    off()
    registry.unregisterAllByPlugin("p")
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it("keeps the catalog identity stable between changes", () => {
    registry.register("p", { id: "m", title: "M" })
    const first = registry.catalog()
    expect(registry.catalog()).toBe(first)
    registry.register("p", { id: "n", title: "N" })
    expect(registry.catalog()).not.toBe(first)
  })

  describe("visibility", () => {
    it("tells a plugin at once, then on every flip across builds", () => {
      const id = registry.register("p", { id: "m", title: "M" })
      const handler = jest.fn()
      registry.onVisibilityChange(id, handler)
      expect(handler).toHaveBeenLastCalledWith(false)

      registry.setOnScreen("tray-panel", [id])
      expect(handler).toHaveBeenLastCalledWith(true)
      expect(registry.isVisible(id)).toBe(true)

      // A second build showing it changes nothing.
      registry.setOnScreen("phones", [id])
      registry.setOnScreen("tray-panel", null)
      expect(handler).toHaveBeenCalledTimes(2)

      registry.setOnScreen("phones", [])
      expect(handler).toHaveBeenLastCalledWith(false)
      expect(handler).toHaveBeenCalledTimes(3)
    })

    it("stops telling a handler once disposed, or once the module is dropped", () => {
      const id = registry.register("p", { id: "m", title: "M" })
      const handler = jest.fn()
      const off = registry.onVisibilityChange(id, handler)
      off()
      registry.setOnScreen("b", [id])
      expect(handler).toHaveBeenCalledTimes(1)

      const again = jest.fn()
      registry.onVisibilityChange(id, again)
      expect(again).toHaveBeenLastCalledWith(true)
      registry.unregister(id)
      registry.setOnScreen("b", null)
      expect(again).toHaveBeenCalledTimes(1)
    })

    it("keeps telling other handlers when one throws", () => {
      const id = registry.register("p", { id: "m", title: "M" })
      const good = jest.fn()
      registry.onVisibilityChange(id, (visible) => {
        if (visible) throw new Error("boom")
      })
      registry.onVisibilityChange(id, good)
      registry.setOnScreen("b", [id])
      expect(good).toHaveBeenLastCalledWith(true)
    })
  })
})
