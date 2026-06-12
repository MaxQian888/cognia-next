import {
  calculateCost,
  calculateCostFromTokens,
  formatModelPricing,
  getModelPricingUSD,
} from "./usage"

describe("getModelPricingUSD", () => {
  it("looks up USD static pricing without providerId", () => {
    expect(getModelPricingUSD("claude-sonnet-4-6")).toEqual({ input: 3, output: 15 })
  })

  it("converts CNY static pricing to USD", () => {
    const pricing = getModelPricingUSD("glm-4.7")
    expect(pricing).not.toBeNull()
    // CNY price: input 4, output 16; rate 7.25 (1 USD = 7.25 CNY)
    expect(pricing!.input).toBeCloseTo(4 / 7.25, 6)
    expect(pricing!.output).toBeCloseTo(16 / 7.25, 6)
  })

  it("falls back to the built-in provider catalog when providerId is given", () => {
    // OpenCode Go model that does not exist in the global USD/CNY tables.
    expect(getModelPricingUSD("kimi-k2.6", "opencode-go")).toEqual({ input: 0.95, output: 4 })
    expect(getModelPricingUSD("glm-5.1", "opencode-go")).toEqual({ input: 1.4, output: 4.4 })
  })

  it("falls back to the built-in provider catalog for OpenCode Zen models", () => {
    expect(getModelPricingUSD("qwen3.5-plus", "opencode")).toEqual({ input: 0.2, output: 1.2 })
  })

  it("prefers the global USD table over the catalog when both have the model", () => {
    // claude-sonnet-4-6 exists in both; the global table should win.
    expect(getModelPricingUSD("claude-sonnet-4-6", "opencode")).toEqual({ input: 3, output: 15 })
  })

  it("returns null for unknown models", () => {
    expect(getModelPricingUSD("totally-unknown-model")).toBeNull()
    expect(getModelPricingUSD("totally-unknown-model", "opencode")).toBeNull()
  })
})

describe("calculateCost", () => {
  it("uses the catalog fallback when providerId is supplied", () => {
    const cost = calculateCost(
      "kimi-k2.6",
      { prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 },
      "opencode-go"
    )
    expect(cost).toBeCloseTo(0.95 + 4, 6)
  })

  it("returns 0 for unknown models", () => {
    expect(
      calculateCost("unknown", { prompt: 1_000_000, completion: 1_000_000, total: 2_000_000 })
    ).toBe(0)
  })
})

describe("calculateCostFromTokens", () => {
  it("uses the catalog fallback when providerId is supplied", () => {
    expect(calculateCostFromTokens("glm-5.1", 1_000_000, 1_000_000, "opencode-go")).toBeCloseTo(
      1.4 + 4.4,
      6
    )
  })
})

describe("formatModelPricing", () => {
  it("uses the catalog fallback when providerId is supplied", () => {
    const formatted = formatModelPricing("kimi-k2.6", "USD", "opencode-go")
    expect(formatted).not.toBeNull()
    expect(formatted!.input).toContain("0.95")
    expect(formatted!.output).toContain("4.00")
  })
})
