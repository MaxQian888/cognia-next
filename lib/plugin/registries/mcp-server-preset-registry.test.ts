import type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"
import {
  __resetMcpServerPresetsForTesting,
  getMcpServerPreset,
  getMcpServerPresetEntry,
  listMcpServerPresetEntries,
  listMcpServerPresetIds,
  registerMcpServerPreset,
  unregisterMcpServerPresetById,
  unregisterMcpServerPresetsByPlugin,
} from "./mcp-server-preset-registry"

function makePreset(
  id: string,
  overrides: Partial<PluginMcpServerPresetDef> = {}
): PluginMcpServerPresetDef {
  return {
    id,
    name: `Preset ${id}`,
    transport: "stdio",
    config: {},
    ...overrides,
  }
}

describe("mcp-server-preset-registry", () => {
  // Reset the singleton state before every test so registration order from
  // earlier cases never leaks into the next one.
  beforeEach(() => {
    __resetMcpServerPresetsForTesting()
  })

  it("registers a preset and retrieves it via get / getEntry / list", () => {
    const preset = makePreset("test", { description: "for tests" })
    const previous = registerMcpServerPreset("test", preset, { pluginId: "p1" })
    expect(previous).toBeUndefined()

    expect(getMcpServerPreset("test")).toBe(preset)
    expect(getMcpServerPresetEntry("test")).toEqual({
      entry: preset,
      pluginId: "p1",
    })
    expect(listMcpServerPresetIds()).toEqual(["test"])
    expect(listMcpServerPresetEntries()).toEqual([{ id: "test", entry: preset, pluginId: "p1" }])
  })

  it("unregisterByPlugin drops every preset from the given pluginId", () => {
    registerMcpServerPreset("a", makePreset("a"), { pluginId: "plug" })
    registerMcpServerPreset("b", makePreset("b"), { pluginId: "plug" })

    const removed = unregisterMcpServerPresetsByPlugin("plug")
    expect(removed).toBe(2)
    expect(getMcpServerPreset("a")).toBeUndefined()
    expect(getMcpServerPreset("b")).toBeUndefined()
    expect(listMcpServerPresetIds()).toEqual([])
  })

  it("unregisterByPlugin leaves entries from other plugins alone", () => {
    const a = makePreset("a")
    const b = makePreset("b")
    registerMcpServerPreset("a", a, { pluginId: "pluginA" })
    registerMcpServerPreset("b", b, { pluginId: "pluginB" })

    const removed = unregisterMcpServerPresetsByPlugin("pluginA")
    expect(removed).toBe(1)
    expect(getMcpServerPreset("a")).toBeUndefined()
    expect(getMcpServerPreset("b")).toBe(b)
  })

  it("unregisterById removes only the matching entry", () => {
    registerMcpServerPreset("a", makePreset("a"))
    registerMcpServerPreset("b", makePreset("b"))

    expect(unregisterMcpServerPresetById("a")).toBe(true)
    expect(getMcpServerPreset("a")).toBeUndefined()
    expect(getMcpServerPreset("b")).toBeDefined()

    // Second call for a now-missing id reports false.
    expect(unregisterMcpServerPresetById("a")).toBe(false)
  })

  it("__resetMcpServerPresetsForTesting clears everything", () => {
    registerMcpServerPreset("a", makePreset("a"), { pluginId: "p1" })
    registerMcpServerPreset("b", makePreset("b"), { pluginId: "p2" })
    registerMcpServerPreset("c", makePreset("c")) // anonymous

    __resetMcpServerPresetsForTesting()

    expect(listMcpServerPresetIds()).toEqual([])
    expect(listMcpServerPresetEntries()).toEqual([])
  })
})
