/**
 * A2UI Date Formatting Utilities Tests
 */

import { formatRelativeTime, formatAbsoluteTime } from "./format"

describe("formatRelativeTime", () => {
  it('should return "just now" for less than 60 seconds', () => {
    expect(formatRelativeTime(Date.now() - 30000)).toBe("just now")
    expect(formatRelativeTime(Date.now() - 1000)).toBe("just now")
    expect(formatRelativeTime(Date.now())).toBe("just now")
  })

  it("should return minutes for 1-59 minutes", () => {
    expect(formatRelativeTime(Date.now() - 60000)).toBe("1m ago")
    expect(formatRelativeTime(Date.now() - 300000)).toBe("5m ago")
    expect(formatRelativeTime(Date.now() - 3540000)).toBe("59m ago")
  })

  it("should return hours for 1-23 hours", () => {
    expect(formatRelativeTime(Date.now() - 3600000)).toBe("1h ago")
    expect(formatRelativeTime(Date.now() - 7200000)).toBe("2h ago")
    expect(formatRelativeTime(Date.now() - 82800000)).toBe("23h ago")
  })

  it("should return days for 1-6 days", () => {
    expect(formatRelativeTime(Date.now() - 86400000)).toBe("1d ago")
    expect(formatRelativeTime(Date.now() - 172800000)).toBe("2d ago")
    expect(formatRelativeTime(Date.now() - 518400000)).toBe("6d ago")
  })

  it("should return locale date string for 7+ days", () => {
    const oldTimestamp = Date.now() - 604800000 // exactly 7 days
    const result = formatRelativeTime(oldTimestamp)
    // Should fall through to toLocaleDateString
    expect(result).not.toContain("ago")
    expect(result).not.toBe("just now")
  })
})

describe("formatAbsoluteTime", () => {
  it("should format a timestamp as a localized date string", () => {
    const timestamp = new Date(2025, 0, 15, 14, 30).getTime()
    const result = formatAbsoluteTime(timestamp)
    // Should contain year, month, day, and time components
    expect(result).toContain("2025")
    expect(result).toContain("15")
  })

  it("should accept an optional locale parameter", () => {
    const timestamp = new Date(2025, 0, 15, 14, 30).getTime()
    const enResult = formatAbsoluteTime(timestamp, "en-US")
    const zhResult = formatAbsoluteTime(timestamp, "zh-CN")
    // Both should contain the year
    expect(enResult).toContain("2025")
    expect(zhResult).toContain("2025")
  })

  it("should include time components", () => {
    const timestamp = new Date(2025, 5, 20, 9, 45).getTime()
    const result = formatAbsoluteTime(timestamp, "en-US")
    // Should contain the time portion
    expect(result).toContain("45")
  })
})
