import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"

import definition, { manifest } from "./index"

describe("Figma external service reference plugin", () => {
  it("keeps all vendor-specific policy inside the plugin manifest", () => {
    expect(validatePluginManifest(manifest).errors).toEqual([])
    expect(manifest.services).toEqual([
      expect.objectContaining({
        id: "figma",
        providers: expect.arrayContaining([
          expect.objectContaining({ id: "desktop", availability: "supported" }),
          expect.objectContaining({ id: "remote", availability: "vendor-pending" }),
        ]),
      }),
    ])
    expect(manifest.mcpServerPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "figma-desktop",
          config: { url: "http://127.0.0.1:3845/mcp" },
          provisioning: expect.objectContaining({ mode: "managed" }),
        }),
        expect.objectContaining({
          id: "figma-remote",
          config: { url: "https://mcp.figma.com/mcp" },
        }),
      ])
    )
  })

  it("ships no skills, so it does not advertise any", () => {
    // The settings card renders `skillIds.length` as "N skills"; ids with no
    // skill behind them would advertise capabilities that do not exist.
    for (const service of manifest.services ?? []) expect(service.skillIds).toBeUndefined()
    expect(manifest.skills).toBeUndefined()
  })

  it("says the desktop-local provider is unavailable on mobile", () => {
    const desktop = manifest.mcpServerPresets?.find((preset) => preset.id === "figma-desktop")
    expect(desktop?.description).toMatch(/unavailable on mobile/)
    expect(manifest.runtimeCompatibility?.mobile?.availability).toBe("degraded")
    expect(manifest.runtimeCompatibility?.mobile?.reason).toMatch(/Figma Desktop provider/)
  })

  it("exports the manifest-driven definition", () => {
    expect(definition.manifest).toBe(manifest)
  })

  it("fails closed for newly discovered tools outside reviewed risk overlays", () => {
    const remote = manifest.mcpServerPresets?.find((preset) => preset.id === "figma-remote")
    expect(remote?.toolRiskRules).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: "*" })])
    )
  })
})
