import { estimateFallbackTokens, resolveTokenCount } from "./fallback-estimator"

describe("cl100k fallback token estimator", () => {
  it("counts Latin, CJK, and mixed text with the shared tokenizer", () => {
    expect(estimateFallbackTokens("Hello world")).toBeGreaterThan(0)
    expect(estimateFallbackTokens("你好，世界")).toBeGreaterThan(0)
    expect(estimateFallbackTokens("Cognia 支持 Bedrock")).toBeGreaterThan(0)
  })

  it("returns zero for empty input", () => {
    expect(estimateFallbackTokens("")).toBe(0)
    expect(estimateFallbackTokens(null)).toBe(0)
  })

  it("keeps provider-reported usage authoritative", () => {
    expect(resolveTokenCount("a very long fallback string", 7)).toBe(7)
    expect(resolveTokenCount("fallback", undefined)).toBe(estimateFallbackTokens("fallback"))
  })
})
