import {
  COMPARISON_MAX_MODELS,
  comparisonModelKey,
  formatTokenCount,
  formatUsdPerMillion,
} from "./model-format"

describe("formatTokenCount", () => {
  it("formats kilotokens without decimals", () => {
    expect(formatTokenCount(128_000)).toBe("128K")
    expect(formatTokenCount(200_000)).toBe("200K")
    expect(formatTokenCount(8_192)).toBe("8K")
  })

  it("formats megatokens with one decimal only when needed", () => {
    expect(formatTokenCount(1_000_000)).toBe("1M")
    expect(formatTokenCount(1_500_000)).toBe("1.5M")
    expect(formatTokenCount(2_097_152)).toBe("2.1M")
  })

  it("keeps sub-1K counts verbatim and dashes the absent case", () => {
    expect(formatTokenCount(900)).toBe("900")
    expect(formatTokenCount(0)).toBe("—")
    expect(formatTokenCount(Number.NaN)).toBe("—")
  })
})

describe("formatUsdPerMillion", () => {
  it("prints two decimals and a bare $0 for free tiers", () => {
    expect(formatUsdPerMillion(3)).toBe("$3.00")
    expect(formatUsdPerMillion(0.15)).toBe("$0.15")
    expect(formatUsdPerMillion(0)).toBe("$0")
    expect(formatUsdPerMillion(Number.NaN)).toBe("—")
  })
})

describe("comparison keys", () => {
  it("qualifies a model id with its provider, keeping any colon in the model id", () => {
    expect(comparisonModelKey("bedrock", "us.anthropic:claude")).toBe("bedrock:us.anthropic:claude")
  })

  it("pins the shared selection cap", () => {
    expect(COMPARISON_MAX_MODELS).toBe(4)
  })
})
