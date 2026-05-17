import * as sdk from "./mcp-server-preset"

describe("plugin-sdk: api/mcp-server-preset", () => {
  it("re-exports the helper + registry functions plugin authors call", () => {
    expect(typeof sdk.defineMcpServerPreset).toBe("function")
    expect(typeof sdk.registerMcpServerPreset).toBe("function")
    expect(typeof sdk.unregisterMcpServerPresetById).toBe("function")
    expect(typeof sdk.unregisterMcpServerPresetsByPlugin).toBe("function")
    expect(typeof sdk.getMcpServerPreset).toBe("function")
    expect(typeof sdk.getMcpServerPresetEntry).toBe("function")
    expect(typeof sdk.listMcpServerPresetIds).toBe("function")
    expect(typeof sdk.listMcpServerPresetEntries).toBe("function")
  })

  it("defineMcpServerPreset is a typesafe identity function", () => {
    const def = sdk.defineMcpServerPreset({
      id: "playwright",
      name: "Playwright",
      description: "Browser automation",
      transport: "stdio",
      config: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    })
    expect(def.id).toBe("playwright")
    expect(def.transport).toBe("stdio")
  })
})
