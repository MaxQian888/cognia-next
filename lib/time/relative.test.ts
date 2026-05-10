import { formatRelative } from "./relative"

describe("formatRelative", () => {
  const NOW = 1_700_000_000_000

  it("returns 'just now' under 1 minute", () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe("just now")
    expect(formatRelative(NOW - 59_999, NOW)).toBe("just now")
  })

  it("treats future timestamps as 'just now'", () => {
    expect(formatRelative(NOW + 5_000, NOW)).toBe("just now")
  })

  it("returns minute buckets between 1m and 1h", () => {
    expect(formatRelative(NOW - 60_000, NOW)).toBe("1m ago")
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("5m ago")
    expect(formatRelative(NOW - 59 * 60_000, NOW)).toBe("59m ago")
  })

  it("returns hour buckets between 1h and 24h", () => {
    expect(formatRelative(NOW - 60 * 60_000, NOW)).toBe("1h ago")
    expect(formatRelative(NOW - 23 * 60 * 60_000, NOW)).toBe("23h ago")
  })

  it("returns day buckets at 24h and beyond", () => {
    expect(formatRelative(NOW - 24 * 60 * 60_000, NOW)).toBe("1d ago")
    expect(formatRelative(NOW - 7 * 24 * 60 * 60_000, NOW)).toBe("7d ago")
  })

  it("falls back to Date.now() when `now` is omitted", () => {
    const value = formatRelative(Date.now() - 30_000)
    expect(value).toBe("just now")
  })
})
