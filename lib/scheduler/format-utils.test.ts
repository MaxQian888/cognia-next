/**
 * Format Utilities Tests
 */

import { formatDuration, formatInterval, formatNextRun, formatRelativeTime } from "./format-utils"

describe("formatDuration", () => {
  it("should return dash for undefined", () => {
    expect(formatDuration(undefined)).toBe("-")
  })

  it("should return dash for zero", () => {
    expect(formatDuration(0)).toBe("-")
  })

  it("should format milliseconds", () => {
    expect(formatDuration(500)).toBe("500ms")
  })

  it("should format seconds", () => {
    expect(formatDuration(5000)).toBe("5.0s")
    expect(formatDuration(1500)).toBe("1.5s")
  })

  it("should format minutes and seconds", () => {
    expect(formatDuration(90000)).toBe("1m 30s")
    expect(formatDuration(300000)).toBe("5m 0s")
  })

  it("should format hours and minutes", () => {
    expect(formatDuration(3600000)).toBe("1h 0m")
    expect(formatDuration(5400000)).toBe("1h 30m")
  })
})

describe("formatInterval", () => {
  it("promotes whole days and hours so a weekly backup is not 10080m", () => {
    expect(formatInterval(7 * 24 * 60 * 60_000)).toBe("7d")
    expect(formatInterval(24 * 60 * 60_000)).toBe("1d")
    expect(formatInterval(23 * 60 * 60_000)).toBe("23h")
    expect(formatInterval(5 * 60_000)).toBe("5m")
  })

  it("keeps a partial unit in minutes rather than rounding to a run it never makes", () => {
    expect(formatInterval(90 * 60_000)).toBe("90m")
    // Whole hours still promote past a day boundary: 25h is 25h, not 1500m.
    expect(formatInterval(25 * 60 * 60_000)).toBe("25h")
    expect(formatInterval(36 * 60 * 60_000 + 30 * 60_000)).toBe("2190m")
  })

  it("answers 0m for a missing or non-positive interval", () => {
    expect(formatInterval(undefined)).toBe("0m")
    expect(formatInterval(0)).toBe("0m")
    expect(formatInterval(-1)).toBe("0m")
    expect(formatInterval(100)).toBe("0m")
  })
})

describe("formatRelativeTime", () => {
  it("should return dash for undefined", () => {
    expect(formatRelativeTime(undefined)).toBe("-")
  })

  it("should return Overdue for past dates", () => {
    const past = new Date(Date.now() - 60000)
    expect(formatRelativeTime(past)).toBe("Overdue")
  })

  it("should return custom overdue label", () => {
    const past = new Date(Date.now() - 60000)
    expect(formatRelativeTime(past, { overdue: "Past" })).toBe("Past")
  })

  it("should return < 1 min for near future", () => {
    const soon = new Date(Date.now() + 30000)
    expect(formatRelativeTime(soon)).toBe("< 1 min")
  })

  it("should return minutes", () => {
    // Pad above the unit boundary so micro-second elapse between Date.now()
    // and formatRelativeTime()'s internal new Date() can't pull the diff
    // back below 5 * 60000 ms and trip Math.floor() down to 4.
    const inMinutes = new Date(Date.now() + 5 * 60000 + 1000)
    expect(formatRelativeTime(inMinutes)).toBe("5m")
  })

  it("should return hours", () => {
    // Same boundary-padding rationale as the "should return minutes" case.
    const inHours = new Date(Date.now() + 3 * 3600000 + 1000)
    expect(formatRelativeTime(inHours)).toBe("3h")
  })

  it("should return days", () => {
    const inDays = new Date(Date.now() + 2 * 86400000 + 60000)
    expect(formatRelativeTime(inDays)).toBe("2d")
  })
})

describe("formatNextRun", () => {
  it("should return No schedule for undefined", () => {
    expect(formatNextRun(undefined)).toBe("No schedule")
  })

  it("should use custom noSchedule label", () => {
    expect(formatNextRun(undefined, { noSchedule: "N/A" })).toBe("N/A")
  })

  it("should return formatted date for far future", () => {
    const farFuture = new Date(Date.now() + 5 * 86400000)
    const result = formatNextRun(farFuture)
    // Should contain month abbreviation
    expect(result).toBeTruthy()
    expect(result).not.toBe("No schedule")
  })

  it("should return Overdue for past dates", () => {
    const past = new Date(Date.now() - 60_000)
    expect(formatNextRun(past)).toBe("Overdue")
  })

  it("should return custom overdue label", () => {
    const past = new Date(Date.now() - 60_000)
    expect(formatNextRun(past, { overdue: "Past!" })).toBe("Past!")
  })

  it("should return < 1 min for near future", () => {
    const soon = new Date(Date.now() + 30_000)
    expect(formatNextRun(soon)).toBe("< 1 min")
  })

  it("should use custom lessThanMinute label", () => {
    const soon = new Date(Date.now() + 30_000)
    expect(formatNextRun(soon, { lessThanMinute: "imminent" })).toBe("imminent")
  })

  it("should return minutes for upcoming runs under an hour", () => {
    // +1s padding: formatNextRun uses Math.floor(diff/60000), so without
    // padding the test races against the GC and occasionally rounds 5*60000
    // down to 4 minutes.
    const inMinutes = new Date(Date.now() + 5 * 60_000 + 1000)
    expect(formatNextRun(inMinutes)).toBe("5m")
  })

  it("should return hours for upcoming runs in the next day", () => {
    const inHours = new Date(Date.now() + 4 * 3_600_000 + 1000)
    expect(formatNextRun(inHours)).toBe("4h")
  })
})
