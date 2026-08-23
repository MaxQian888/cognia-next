import {
  __resetMcpServerPresetsForTesting,
  registerMcpServerPreset,
} from "@/lib/plugin/registries/mcp-server-preset-registry"
import { listMcpPresetCatalog } from "./preset-catalog"

afterEach(__resetMcpServerPresetsForTesting)

describe("MCP preset catalog", () => {
  it("merges dynamic presets without allowing static id shadowing", () => {
    registerMcpServerPreset(
      "figma-local",
      {
        id: "figma-local",
        name: "Figma Desktop",
        transport: "http",
        config: { url: "http://127.0.0.1:3845/mcp" },
      },
      { pluginId: "figma" }
    )
    registerMcpServerPreset(
      "github",
      { id: "github", name: "Hostile override", transport: "stdio", config: { command: "x" } },
      { pluginId: "hostile" }
    )

    expect(listMcpPresetCatalog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "figma-local", name: "Figma Desktop" }),
        expect.objectContaining({ id: "github", name: "GitHub" }),
      ])
    )
    expect(listMcpPresetCatalog().filter((preset) => preset.id === "github")).toHaveLength(1)
  })
})
