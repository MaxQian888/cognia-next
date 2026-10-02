import {
  ageParts,
  formatBucketPeriod,
  formatList,
  formatLocalDateTime,
  formatUtcDate,
  formatUtcDateTime,
  formatUtcDateTimeBare,
} from "./status-format"

describe("status formatting", () => {
  it("formats instants in UTC with and without the zone label", () => {
    expect(formatUtcDateTime("2026-10-02T09:05:00.000Z", "en")).toMatch(/Oct 2, 2026.*09:05.*UTC/)
    expect(formatUtcDateTimeBare("2026-10-02T09:05:00.000Z", "en")).toMatch(/Oct 2, 2026.*09:05/)
    expect(formatUtcDateTimeBare("2026-10-02T09:05:00.000Z", "en")).not.toMatch(/UTC/)
    expect(formatUtcDate("2026-10-02T23:59:00.000Z", "en")).toBe("Oct 2, 2026")
  })

  it("formats the same instant in a given local zone", () => {
    expect(formatLocalDateTime("2026-10-02T09:05:00.000Z", "en", "Asia/Shanghai")).toMatch(/17:05/)
  })

  it("returns unparseable input unchanged instead of 'Invalid Date'", () => {
    expect(formatUtcDateTime("yesterday", "en")).toBe("yesterday")
  })

  it("labels hourly and daily history periods in UTC, never as 24:00", () => {
    expect(
      formatBucketPeriod(
        { start: "2026-10-02T23:00:00.000Z", end: "2026-10-03T00:00:00.000Z" },
        "24h",
        "en"
      )
    ).toBe("Oct 2, 2026 23:00–00:00 UTC")
    expect(
      formatBucketPeriod(
        { start: "2026-10-02T00:00:00.000Z", end: "2026-10-03T00:00:00.000Z" },
        "7d",
        "en"
      )
    ).toBe("Oct 2, 2026 UTC")
  })

  it("lists names in the reader's language", () => {
    expect(formatList(["A", "B", "C"], "en")).toBe("A, B, and C")
    expect(formatList(["A", "B"], "zh-CN")).toBe("A和B")
  })

  it("splits snapshot age into the unit the sentence needs", () => {
    expect(ageParts(20_000)).toEqual({ unit: "seconds", count: 20 })
    expect(ageParts(5 * 60_000 + 10)).toEqual({ unit: "minutes", count: 5 })
    expect(ageParts(2 * 3_600_000)).toEqual({ unit: "hours", count: 2 })
  })
})
