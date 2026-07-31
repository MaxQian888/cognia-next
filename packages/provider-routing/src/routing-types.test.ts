import {
  DEFAULT_DIFFICULTY_ROUTING,
  DEFAULT_SEMANTIC_TOOL_ROUTING,
  type DifficultyRoutingSettings,
  type SemanticToolRoutingSettings,
  type ToolRouteRecord,
} from "./routing-types"

describe("provider-routing local routing types", () => {
  it("exports semantic tool routing defaults", () => {
    const settings: SemanticToolRoutingSettings = DEFAULT_SEMANTIC_TOOL_ROUTING

    expect(settings.enabled).toBe(false)
    expect(settings.activationToolCount).toBe(24)
    expect(settings.topK).toBe(12)
    expect(settings.pinnedTools).toEqual([])
  })

  it("exports difficulty routing defaults", () => {
    const settings: DifficultyRoutingSettings = DEFAULT_DIFFICULTY_ROUTING

    expect(settings.enabled).toBe(false)
    expect(settings.threshold).toBe(0.5)
  })

  it("models persisted tool routes locally", () => {
    const route: ToolRouteRecord = {
      id: "user:tool:search",
      kind: "tool",
      refId: "search",
      utterances: ["find files"],
      enabled: true,
      source: "user",
      updatedAt: 1,
    }

    expect(route.kind).toBe("tool")
  })
})
