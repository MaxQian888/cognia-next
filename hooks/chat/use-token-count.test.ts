import { calculateTokenBreakdown, countTokens } from "./use-token-count"

describe("countTokens", () => {
  it("returns 0 for null, undefined, or empty input", () => {
    expect(countTokens(null)).toBe(0)
    expect(countTokens(undefined)).toBe(0)
    expect(countTokens("")).toBe(0)
  })

  it("rounds up length / 4 for short strings", () => {
    expect(countTokens("a")).toBe(1) // ceil(1/4)
    expect(countTokens("abcd")).toBe(1) // ceil(4/4)
    expect(countTokens("abcde")).toBe(2) // ceil(5/4)
  })

  it("scales linearly for larger strings", () => {
    expect(countTokens("a".repeat(100))).toBe(25)
    expect(countTokens("a".repeat(1001))).toBe(251)
  })
})

describe("calculateTokenBreakdown", () => {
  it("returns zero total and empty byMessage for empty array", () => {
    expect(calculateTokenBreakdown([])).toEqual({ total: 0, byMessage: [] })
  })

  it("computes per-message counts and their sum", () => {
    const result = calculateTokenBreakdown(["abcd", "abcdefgh", "x"])
    expect(result.byMessage).toEqual([1, 2, 1])
    expect(result.total).toBe(4)
  })

  it("treats null/undefined entries as zero tokens", () => {
    const result = calculateTokenBreakdown(["abcd", null, undefined, "x"])
    expect(result.byMessage).toEqual([1, 0, 0, 1])
    expect(result.total).toBe(2)
  })
})
