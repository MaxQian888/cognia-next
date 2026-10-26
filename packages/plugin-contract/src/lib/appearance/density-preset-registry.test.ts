import {
  registerDensityPreset,
  registerDensityPresetsForPlugin,
  unregisterDensityPresetsByPlugin,
  getDensityPreset,
  listDensityPresets,
  subscribeDensityPresets,
  __resetDensityPresetRegistryForTesting,
} from "./density-preset-registry"

afterEach(() => {
  __resetDensityPresetRegistryForTesting()
})

describe("density-preset-registry", () => {
  it("registers a single preset and looks it up by name", () => {
    registerDensityPreset("p1", { name: "cozy", vars: { "--density-spacing": "0.5rem" } })
    expect(getDensityPreset("cozy")?.vars["--density-spacing"]).toBe("0.5rem")
    expect(listDensityPresets()).toHaveLength(1)
  })

  it("ignores presets with a blank name", () => {
    registerDensityPreset("p1", { name: "   ", vars: {} })
    expect(listDensityPresets()).toHaveLength(0)
  })

  it("batch-registers and replaces a plugin's prior set", () => {
    expect(
      registerDensityPresetsForPlugin("p1", [
        { name: "a", vars: {} },
        { name: "b", vars: {} },
      ])
    ).toBe(2)
    expect(listDensityPresets()).toHaveLength(2)
    // Re-register replaces the plugin's set (a is gone, only c remains).
    expect(registerDensityPresetsForPlugin("p1", [{ name: "c", vars: {} }])).toBe(1)
    expect(listDensityPresets().map((p) => p.name)).toEqual(["c"])
  })

  it("scopes removal to the named plugin", () => {
    registerDensityPresetsForPlugin("p1", [{ name: "a", vars: {} }])
    registerDensityPresetsForPlugin("p2", [{ name: "b", vars: {} }])
    expect(unregisterDensityPresetsByPlugin("p1")).toBe(1)
    expect(listDensityPresets().map((p) => p.name)).toEqual(["b"])
    expect(unregisterDensityPresetsByPlugin("ghost")).toBe(0)
  })

  it("notifies subscribers on change and stabilizes the snapshot", () => {
    const fires: number[] = []
    const unsub = subscribeDensityPresets(() => fires.push(listDensityPresets().length))
    const first = listDensityPresets()
    expect(listDensityPresets()).toBe(first) // cached identity
    registerDensityPreset("p1", { name: "a", vars: {} })
    expect(fires).toEqual([1])
    expect(listDensityPresets()).not.toBe(first)
    unsub()
  })
})
