import {
  cacheHitRate,
  calculateCost,
  calculateCostFromTokens,
  formatDuration,
  formatModelPricing,
  formatPercent,
  formatTokensPerSec,
  getModelPricingUSD,
  tokensPerSecond,
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

describe("tokensPerSecond", () => {
  it("divides output tokens by the duration in seconds", () => {
    expect(tokensPerSecond(450, 10_000)).toBe(45) // 450 tok / 10s
    expect(tokensPerSecond(1000, 2000)).toBe(500)
  })

  it("returns null when there is no timed generation to divide by", () => {
    expect(tokensPerSecond(500, 0)).toBeNull() // non-SDK turn, durationMs 0
    expect(tokensPerSecond(0, 5000)).toBeNull() // no output
    expect(tokensPerSecond(500, -1)).toBeNull()
    expect(tokensPerSecond(Number.NaN, 5000)).toBeNull()
  })
})

describe("formatTokensPerSec", () => {
  it("formats compactly with unit left to the caller", () => {
    expect(formatTokensPerSec(45.4)).toBe("45")
    expect(formatTokensPerSec(9.24)).toBe("9.2")
    expect(formatTokensPerSec(1250)).toBe("1.3K")
    expect(formatTokensPerSec(0)).toBe("0")
    expect(formatTokensPerSec(Number.NaN)).toBe("0")
  })
})

describe("cacheHitRate", () => {
  it("is read / (read + write)", () => {
    expect(cacheHitRate(750, 250)).toBe(0.75)
    expect(cacheHitRate(0, 100)).toBe(0)
  })

  it("returns 0 when there is no cache activity", () => {
    expect(cacheHitRate(0, 0)).toBe(0)
    expect(cacheHitRate(Number.NaN, Number.NaN)).toBe(0)
  })
})

describe("formatPercent", () => {
  it("rounds a [0,1] fraction to an integer percent, clamped", () => {
    expect(formatPercent(0.383)).toBe("38%")
    expect(formatPercent(1.4)).toBe("100%")
    expect(formatPercent(-0.2)).toBe("0%")
    expect(formatPercent(Number.NaN)).toBe("0%")
  })
})

describe("formatDuration", () => {
  it("renders sub-second, seconds, minutes and hours", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(820)).toBe("820ms")
    expect(formatDuration(3140)).toBe("3.1s")
    expect(formatDuration(42_000)).toBe("42s")
    expect(formatDuration(63_000)).toBe("1m 03s")
    expect(formatDuration(3_720_000)).toBe("1h 02m")
  })
})
