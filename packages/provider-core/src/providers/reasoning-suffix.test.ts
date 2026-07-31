import { baseModelId, effortForModel, parseReasoningSuffix } from "./reasoning-suffix"

describe("parseReasoningSuffix", () => {
  it("splits a virtual id into base + effort", () => {
    expect(parseReasoningSuffix("gpt-5-high")).toEqual({ baseModel: "gpt-5", effort: "high" })
    expect(parseReasoningSuffix("o3-low")).toEqual({ baseModel: "o3", effort: "low" })
    expect(parseReasoningSuffix("claude-opus-thinking-max")).toEqual({
      baseModel: "claude-opus-thinking",
      effort: "max",
    })
  })

  it("is case-insensitive on the tier token", () => {
    expect(parseReasoningSuffix("gpt-5-HIGH")).toEqual({ baseModel: "gpt-5", effort: "high" })
  })

  it("recognises every tier", () => {
    for (const tier of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(parseReasoningSuffix(`m-${tier}`)).toEqual({ baseModel: "m", effort: tier })
    }
  })

  it("leaves ordinary ids untouched", () => {
    expect(parseReasoningSuffix("gpt-5")).toBeNull()
    expect(parseReasoningSuffix("claude-3-5-sonnet")).toBeNull()
    expect(parseReasoningSuffix("llama-3.3-70b")).toBeNull()
    // A trailing hyphen or a leading-hyphen effort is not a virtual id.
    expect(parseReasoningSuffix("gpt-5-")).toBeNull()
    expect(parseReasoningSuffix("-high")).toBeNull()
    expect(parseReasoningSuffix("high")).toBeNull()
  })

  it("effortForModel and baseModelId are convenience projections", () => {
    expect(effortForModel("gpt-5-high")).toBe("high")
    expect(effortForModel("gpt-5")).toBeNull()
    expect(baseModelId("gpt-5-high")).toBe("gpt-5")
    expect(baseModelId("gpt-5")).toBe("gpt-5")
  })
})
