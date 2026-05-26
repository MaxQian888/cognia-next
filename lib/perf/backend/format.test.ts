import { formatBytes, formatBytesPerSec, formatCount, formatMs, formatPercent } from "./format"

describe("formatBytes", () => {
  it("returns 0 B for non-positive / non-finite input", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(-5)).toBe("0 B")
    expect(formatBytes(Number.NaN)).toBe("0 B")
  })

  it("formats bytes without decimals and larger units with one", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MB")
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB")
  })

  it("clamps to the largest unit", () => {
    expect(formatBytes(1024 ** 6)).toContain("TB")
  })
})

describe("formatBytesPerSec", () => {
  it("appends /s and handles zero", () => {
    expect(formatBytesPerSec(0)).toBe("0 B/s")
    expect(formatBytesPerSec(1024)).toBe("1.0 KB/s")
  })
})

describe("formatPercent", () => {
  it("formats with one decimal and handles zero", () => {
    expect(formatPercent(0)).toBe("0%")
    expect(formatPercent(-1)).toBe("0%")
    expect(formatPercent(42.345)).toBe("42.3%")
  })
})

describe("formatMs", () => {
  it("handles zero / non-finite", () => {
    expect(formatMs(0)).toBe("0 ms")
    expect(formatMs(Number.NaN)).toBe("0 ms")
  })

  it("scales sub-ms to µs", () => {
    expect(formatMs(0.5)).toBe("500 µs")
  })

  it("shows ms with adaptive precision", () => {
    expect(formatMs(2.5)).toBe("2.50 ms")
    expect(formatMs(42)).toBe("42 ms")
  })

  it("scales >= 1000ms to seconds", () => {
    expect(formatMs(1500)).toBe("1.50 s")
  })
})

describe("formatCount", () => {
  it("handles zero and small integers", () => {
    expect(formatCount(0)).toBe("0")
    expect(formatCount(42)).toBe("42")
  })

  it("compacts thousands and millions", () => {
    expect(formatCount(12_300)).toBe("12.3k")
    expect(formatCount(2_500_000)).toBe("2.5M")
  })
})
