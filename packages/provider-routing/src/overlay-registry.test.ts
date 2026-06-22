import { createOverlayRegistry, type OverlayRegistry } from "./overlay-registry"

interface TestEntry {
  value: string
}

describe("provider-routing overlay registry", () => {
  let registry: OverlayRegistry<TestEntry>

  beforeEach(() => {
    registry = createOverlayRegistry<TestEntry>({ name: "test" })
  })

  it("registers, lists, reads, and unregisters entries", () => {
    expect(registry.register("a", { value: "one" }, { pluginId: "p1" })).toBeUndefined()
    expect(registry.register("b", { value: "two" }, { pluginId: "p2" })).toBeUndefined()

    expect(registry.get("a")).toEqual({ value: "one" })
    expect(registry.getEntry("b")).toEqual({
      entry: { value: "two" },
      pluginId: "p2",
    })
    expect(registry.list()).toEqual(["a", "b"])
    expect(registry.entries()).toEqual([
      { id: "a", entry: { value: "one" }, pluginId: "p1" },
      { id: "b", entry: { value: "two" }, pluginId: "p2" },
    ])

    expect(registry.unregisterById("a")).toBe(true)
    expect(registry.unregisterById("a")).toBe(false)
    expect(registry.unregisterByPlugin("p2")).toBe(1)
    expect(registry.list()).toEqual([])
  })

  it("keeps the incumbent with first-wins-cross-plugin conflicts", () => {
    const onConflict = jest.fn()
    const reg = createOverlayRegistry<TestEntry>({
      name: "routing-strategies",
      conflictPolicy: "first-wins-cross-plugin",
      onConflict,
    })

    reg.register("strategy", { value: "one" }, { pluginId: "p1" })
    const rejected = reg.register("strategy", { value: "two" }, { pluginId: "p2" })

    expect(rejected?.entry).toEqual({ value: "one" })
    expect(reg.get("strategy")).toEqual({ value: "one" })
    expect(onConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "routing-strategies",
        key: "strategy",
        existingPluginId: "p1",
        incomingPluginId: "p2",
      })
    )
  })

  it("supports derived keys and metadata", () => {
    const reg = createOverlayRegistry<TestEntry>({
      keyFn: (id, _entry, opts) => `${opts?.pluginId}:${id}`,
      metadata: (_entry, opts) => ({ pluginId: opts?.pluginId }),
    })

    reg.register("x", { value: "one" }, { pluginId: "p1" })
    reg.register("x", { value: "two" }, { pluginId: "p2" })

    expect(reg.list()).toEqual(["p1:x", "p2:x"])
    expect(reg.getEntry("p1:x")?.meta).toEqual({ pluginId: "p1" })
  })
})
