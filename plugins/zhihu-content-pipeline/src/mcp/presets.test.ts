import {
  STATIC_MCP_PRESETS,
  EXA_PRESET,
  FETCH_PRESET,
  SEQUENTIAL_THINKING_PRESET,
  CLOAK_BROWSER_PRESET,
} from "./presets"

describe("zhihu MCP presets", () => {
  it("ships four static presets, all plugin-namespaced stdio servers", () => {
    expect(STATIC_MCP_PRESETS).toEqual([
      EXA_PRESET,
      FETCH_PRESET,
      SEQUENTIAL_THINKING_PRESET,
      CLOAK_BROWSER_PRESET,
    ])
    for (const p of STATIC_MCP_PRESETS) {
      expect(p.id.startsWith("zhihu-content-pipeline-")).toBe(true)
      expect(p.transport).toBe("stdio")
      expect(p.config).toHaveProperty("command")
      expect(Array.isArray((p.config as { args?: unknown[] }).args)).toBe(true)
    }
  })

  it("requires an EXA_API_KEY env field on the Exa preset", () => {
    const field = EXA_PRESET.fields?.find((f) => f.key === "EXA_API_KEY")
    expect(field?.placement).toBe("env")
    expect(field?.secret).toBe(true)
  })

  it("wires CloakBrowser through Playwright MCP with a CDP arg-replace field", () => {
    const field = CLOAK_BROWSER_PRESET.fields?.find((f) => f.key === "CDP_ENDPOINT")
    expect(field?.placement).toBe("arg-replace")
    expect(field?.token).toBe("<CDP_ENDPOINT>")
    expect((CLOAK_BROWSER_PRESET.config as { args: string[] }).args).toContain("<CDP_ENDPOINT>")
  })

  it("does not ship a zget MCP preset (zget runs via Bash / terminal node)", () => {
    expect(STATIC_MCP_PRESETS.some((p) => p.id.includes("zget"))).toBe(false)
  })
})
