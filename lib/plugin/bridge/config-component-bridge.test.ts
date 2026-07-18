import type { PluginManifest } from "@/types/plugin/plugin"
import {
  __resetConfigComponentBridgeForTesting,
  invalidateConfigComponentForPlugin,
  loadConfigComponent,
  peekConfigComponent,
} from "./config-component-bridge"

const manifest = (entry = "dist/config.js"): PluginManifest =>
  ({
    id: "config-plugin",
    name: "Config plugin",
    version: "1.0.0",
    description: "Config plugin",
    type: "frontend",
    capabilities: ["configuration"],
    main: "dist/index.js",
    configComponent: { entry, export: "Config" },
  }) as PluginManifest

describe("config-component-bridge", () => {
  beforeEach(() => __resetConfigComponentBridgeForTesting())

  it("loads, caches, and invalidates a contained component", async () => {
    const Config = () => null
    const importer = jest.fn(async () => ({ Config }))
    await expect(loadConfigComponent(manifest(), "/plugins/config", { importer })).resolves.toBe(
      Config
    )
    await loadConfigComponent(manifest(), "/plugins/config", { importer })
    expect(importer).toHaveBeenCalledTimes(1)
    expect(importer).toHaveBeenCalledWith("/plugins/config/dist/config.js")

    invalidateConfigComponentForPlugin("config-plugin")
    expect(peekConfigComponent("config-plugin")).toBeUndefined()
  })

  it("rejects traversal before invoking the importer", async () => {
    const importer = jest.fn()
    await expect(
      loadConfigComponent(manifest("..\\outside.js"), "/plugins/config", { importer })
    ).resolves.toBeNull()
    expect(importer).not.toHaveBeenCalled()
    expect(peekConfigComponent("config-plugin")?.error).toMatch(/traversal/)
  })

  it("returns null for missing declarations and exports", async () => {
    const withoutConfig = { ...manifest(), configComponent: undefined }
    await expect(loadConfigComponent(withoutConfig, "/plugins/config")).resolves.toBeNull()
    await expect(
      loadConfigComponent(manifest(), "/plugins/config", { importer: async () => ({}) })
    ).resolves.toBeNull()
  })
})
