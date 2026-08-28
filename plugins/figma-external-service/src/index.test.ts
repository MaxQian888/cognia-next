import { validatePluginManifest } from "@cognia/plugin-sdk"

import { manifest } from "./index"

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

  it("fails closed for newly discovered tools outside reviewed risk overlays", () => {
    const remote = manifest.mcpServerPresets?.find((preset) => preset.id === "figma-remote")
    expect(remote?.toolRiskRules).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: "*" })])
    )
  })
})
