import { LOG_VALUE_MAX_CHARS, truncateForLog } from "./truncate"

describe("truncateForLog", () => {
  it("returns short strings unchanged", () => {
    expect(truncateForLog("hello")).toBe("hello")
    expect(truncateForLog("")).toBe("")
  })

  it("returns a string exactly at the cap unchanged (no marker)", () => {
    const exact = "a".repeat(LOG_VALUE_MAX_CHARS)
    expect(truncateForLog(exact)).toBe(exact)
    expect(truncateForLog(exact)).not.toContain("truncated")
  })

  it("truncates strings longer than the cap and records the omitted count", () => {
    const long = "a".repeat(LOG_VALUE_MAX_CHARS + 100)
    const result = truncateForLog(long)
    expect(result.startsWith("a".repeat(LOG_VALUE_MAX_CHARS))).toBe(true)
    expect(result).toBe(`${"a".repeat(LOG_VALUE_MAX_CHARS)}…[+100 chars truncated]`)
  })

  it("keeps the informative prefix of a base64 data: URI", () => {
    const dataUri = `data:image/png;base64,${"Q".repeat(5_000)}`
    const result = truncateForLog(dataUri, 40)
    expect(result.startsWith("data:image/png;base64,")).toBe(true)
    expect(result).toContain("chars truncated")
    // The bulk is gone: result is the 40-char prefix + a short marker.
    expect(result.length).toBeLessThan(80)
  })

  it("honours a custom maxChars", () => {
    expect(truncateForLog("abcdef", 3)).toBe("abc…[+3 chars truncated]")
  })

  it("clamps a non-positive maxChars to zero", () => {
    expect(truncateForLog("abc", 0)).toBe("…[+3 chars truncated]")
    expect(truncateForLog("abc", -10)).toBe("…[+3 chars truncated]")
  })

  it("floors a fractional maxChars", () => {
    expect(truncateForLog("abcdef", 2.9)).toBe("ab…[+4 chars truncated]")
  })
})
