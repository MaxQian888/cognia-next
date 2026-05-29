import { pluginExposesConfig, filterConfigurablePlugins } from "./plugin-config-utils"
import type { PluginRow } from "@/lib/db/plugin-types"

function row(id: string, manifest: Record<string, unknown>, name = id): PluginRow {
  return {
    id,
    name,
    version: "1.0.0",
    status: "enabled",
    enabled: true,
    source: "local",
    path: `/plugins/${id}`,
    manifest,
  } as PluginRow
}

describe("pluginExposesConfig", () => {
  it("is true for a configSchema with at least one property", () => {
    expect(
      pluginExposesConfig(row("a", { configSchema: { type: "object", properties: { x: {} } } }))
    ).toBe(true)
  })

  it("is false for a configSchema with no properties", () => {
    expect(
      pluginExposesConfig(row("a", { configSchema: { type: "object", properties: {} } }))
    ).toBe(false)
    expect(pluginExposesConfig(row("a", { configSchema: { type: "object" } }))).toBe(false)
  })

  it("is true for a non-empty configComponent string", () => {
    expect(pluginExposesConfig(row("a", { configComponent: "dist/config.js" }))).toBe(true)
  })

  it("is false for a blank configComponent or no config surface", () => {
    expect(pluginExposesConfig(row("a", { configComponent: "  " }))).toBe(false)
    expect(pluginExposesConfig(row("a", {}))).toBe(false)
    expect(pluginExposesConfig(row("a", { manifest: undefined } as never))).toBe(false)
  })
})

describe("filterConfigurablePlugins", () => {
  it("keeps only configurable plugins, sorted by name", () => {
    const plugins = [
      row("z", { configSchema: { properties: { a: {} } } }, "Zeta"),
      row("n", {}, "Nope"),
      row("a", { configComponent: "c.js" }, "Alpha"),
    ]
    expect(filterConfigurablePlugins(plugins).map((p) => p.name)).toEqual(["Alpha", "Zeta"])
  })

  it("returns an empty array when none qualify", () => {
    expect(filterConfigurablePlugins([row("a", {}), row("b", {})])).toEqual([])
  })
})
