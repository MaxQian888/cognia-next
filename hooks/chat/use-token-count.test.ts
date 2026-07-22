import { calculateTokenBreakdown, countTokens } from "./use-token-count"

describe("countTokens", () => {
  it("returns 0 for null, undefined, or empty input", () => {
    expect(countTokens(null)).toBe(0)
    expect(countTokens(undefined)).toBe(0)
    expect(countTokens("")).toBe(0)
  })

  it("uses cl100k for short strings", () => {
    expect(countTokens("a")).toBe(1)
    expect(countTokens("abcd")).toBe(1)
    expect(countTokens("abcde")).toBe(2)
  })

  it("handles multilingual text", () => {
    expect(countTokens("你好，世界")).toBeGreaterThan(0)
    expect(countTokens("Cognia 支持 Bedrock")).toBeGreaterThan(0)
  })
})

describe("calculateTokenBreakdown", () => {
  it("returns zero total and empty byMessage for empty array", () => {
    expect(calculateTokenBreakdown([])).toEqual({ total: 0, byMessage: [] })
  })

  it("computes per-message counts and their sum", () => {
    const result = calculateTokenBreakdown(["abcd", "abcdefgh", "x"])
    expect(result.byMessage).toEqual([1, 1, 1])
    expect(result.total).toBe(3)
  })

  it("treats null/undefined entries as zero tokens", () => {
    const result = calculateTokenBreakdown(["abcd", null, undefined, "x"])
    expect(result.byMessage).toEqual([1, 0, 0, 1])
    expect(result.total).toBe(2)
  })
})
