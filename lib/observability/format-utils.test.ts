import { formatTimestamp, formatBytesCompact, formatRate, formatTokens } from "./format-utils"

describe("formatTimestamp", () => {
  it("renders Date instances", () => {
    const d = new Date("2024-01-01T12:00:00Z")
    const out = formatTimestamp(d)
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(0)
  })

  it("renders epoch ms numbers", () => {
    expect(typeof formatTimestamp(1704110400000)).toBe("string")
  })
})

describe("formatBytesCompact", () => {
  it("returns em-dash for bad input", () => {
    expect(formatBytesCompact(NaN)).toBe("—")
    expect(formatBytesCompact(-1)).toBe("—")
  })

  it("formats sub-KB / KB / MB / GB ranges", () => {
    expect(formatBytesCompact(0)).toBe("0B")
    expect(formatBytesCompact(512)).toBe("512B")
    expect(formatBytesCompact(2048)).toBe("2.0KB")
    expect(formatBytesCompact(2 * 1024 * 1024)).toBe("2.0MB")
    expect(formatBytesCompact(3 * 1024 * 1024 * 1024)).toBe("3.00GB")
  })
})

describe("formatRate", () => {
  it("returns em-dash for non-finite", () => {
    expect(formatRate(NaN)).toBe("—")
    expect(formatRate(Infinity)).toBe("—")
  })

  it("formats with two decimals and optional suffix", () => {
    expect(formatRate(1.234)).toBe("1.23")
    expect(formatRate(0.5, "/s")).toBe("0.50/s")
  })
})

describe("formatTokens", () => {
  it("returns em-dash for null/undefined/NaN", () => {
    expect(formatTokens(null)).toBe("—")
    expect(formatTokens(undefined)).toBe("—")
    expect(formatTokens(NaN)).toBe("—")
  })

  it("rounds and renders sub-1K", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(99.6)).toBe("100")
  })

  it("renders K and M ranges", () => {
    expect(formatTokens(1500)).toBe("1.5K")
    expect(formatTokens(2_500_000)).toBe("2.50M")
  })
})
