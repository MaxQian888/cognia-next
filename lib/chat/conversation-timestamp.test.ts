import {
  CONVERSATION_TIMESTAMP_FORMATS,
  calendarDayKey,
  calendarDaysBetween,
  calendarYearOf,
  conversationTimestampShape,
  msUntilNextCalendarDay,
} from "@/lib/chat/conversation-timestamp"

// Fixed clock so calendar-day boundaries are deterministic. Local time on
// purpose: the helper reasons in calendar days, which is a local-time concept.
const NOW = new Date(2026, 7, 15, 10, 30).getTime()
const day = (offsetDays: number, hour = 10) => new Date(2026, 7, 15 - offsetDays, hour, 0).getTime()

describe("conversationTimestampShape", () => {
  it("shows a clock time for today", () => {
    expect(conversationTimestampShape(NOW, day(0))).toBe("time")
    // Earliest moment of today still counts as today.
    expect(conversationTimestampShape(NOW, new Date(2026, 7, 15, 0, 0).getTime())).toBe("time")
  })

  it("clamps a future timestamp to today rather than rendering a future date", () => {
    expect(conversationTimestampShape(NOW, day(-3))).toBe("time")
  })

  it("shows a weekday inside the last week", () => {
    // Late yesterday reads as yesterday at 10:30 today — a calendar boundary,
    // not a rolling 24h window.
    expect(conversationTimestampShape(NOW, new Date(2026, 7, 14, 23, 50).getTime())).toBe("weekday")
    expect(conversationTimestampShape(NOW, day(6))).toBe("weekday")
  })

  it("switches to a date on the seventh day", () => {
    expect(conversationTimestampShape(NOW, day(7))).toBe("date")
    expect(conversationTimestampShape(NOW, day(200))).toBe("date")
  })

  it("adds the year once the timestamp leaves the current calendar year", () => {
    expect(conversationTimestampShape(NOW, new Date(2025, 11, 31, 23, 0).getTime())).toBe(
      "dateWithYear"
    )
  })

  it("keeps a same-year date from December without a year", () => {
    const decemberNow = new Date(2026, 11, 20, 9, 0).getTime()
    expect(conversationTimestampShape(decemberNow, new Date(2026, 0, 5).getTime())).toBe("date")
  })
})

describe("CONVERSATION_TIMESTAMP_FORMATS", () => {
  it("declares options for every shape", () => {
    expect(Object.keys(CONVERSATION_TIMESTAMP_FORMATS).sort()).toEqual([
      "date",
      "dateWithYear",
      "time",
      "weekday",
    ])
  })

  it("produces the intended narrow renderings", () => {
    const at = new Date(2026, 7, 3, 14, 32)
    const render = (shape: keyof typeof CONVERSATION_TIMESTAMP_FORMATS) =>
      new Intl.DateTimeFormat("en-US", CONVERSATION_TIMESTAMP_FORMATS[shape]).format(at)
    expect(render("time")).toBe("2:32 PM")
    expect(render("weekday")).toBe("Mon")
    expect(render("date")).toBe("Aug 3")
    expect(render("dateWithYear")).toBe("8/3/2026")
  })
})

describe("zone-aware calendar", () => {
  // Fixed UTC instants, so these hold whatever zone the test machine is in:
  // 06:30 UTC on Aug 15 is 14:30 in Shanghai (UTC+8) and 23:30 the day before
  // in Los Angeles (UTC-7 in August).
  const now = Date.UTC(2026, 7, 15, 6, 30)
  const lateAug14Utc = Date.UTC(2026, 7, 14, 17, 0) // 01:00 Aug 15 in Shanghai

  it("decides today / yesterday in the zone the time is printed in", () => {
    // The bug this fixes: a zone-less "today" check next to a UTC formatter
    // printed 14:32 local as 06:32. The shape now follows the formatter's zone.
    expect(conversationTimestampShape(now, lateAug14Utc, "Asia/Shanghai")).toBe("time")
    expect(conversationTimestampShape(now, lateAug14Utc, "UTC")).toBe("weekday")
    expect(calendarDaysBetween(now, lateAug14Utc, "Asia/Shanghai")).toBe(0)
    expect(calendarDaysBetween(now, lateAug14Utc, "UTC")).toBe(1)
    expect(calendarDaysBetween(now, lateAug14Utc, "America/Los_Angeles")).toBe(0)
  })

  it("is negative for a future timestamp, which the shape clamps to today", () => {
    const tomorrow = Date.UTC(2026, 7, 16, 6, 30)
    expect(calendarDaysBetween(now, tomorrow, "UTC")).toBe(-1)
    expect(conversationTimestampShape(now, tomorrow, "UTC")).toBe("time")
  })

  it("reads the year in the zone, so New Year's Eve lands in the right one", () => {
    const eve = Date.UTC(2025, 11, 31, 20, 0) // 04:00 Jan 1 2026 in Shanghai
    expect(calendarYearOf(eve, "UTC")).toBe(2025)
    expect(calendarYearOf(eve, "Asia/Shanghai")).toBe(2026)
    const later = Date.UTC(2026, 2, 1, 12, 0)
    expect(conversationTimestampShape(later, eve, "UTC")).toBe("dateWithYear")
    expect(conversationTimestampShape(later, eve, "Asia/Shanghai")).toBe("date")
  })

  it("changes the day key exactly at the zone's midnight", () => {
    const beforeMidnightShanghai = Date.UTC(2026, 7, 14, 15, 59, 59)
    const midnightShanghai = Date.UTC(2026, 7, 14, 16, 0, 0)
    expect(calendarDayKey(beforeMidnightShanghai, "Asia/Shanghai")).not.toBe(
      calendarDayKey(midnightShanghai, "Asia/Shanghai")
    )
    expect(calendarDayKey(beforeMidnightShanghai, "UTC")).toBe(
      calendarDayKey(midnightShanghai, "UTC")
    )
  })

  it("measures the wait to the next midnight in the zone", () => {
    expect(msUntilNextCalendarDay(Date.UTC(2026, 7, 14, 15, 59, 0), "Asia/Shanghai")).toBe(60_000)
    expect(msUntilNextCalendarDay(Date.UTC(2026, 7, 14, 23, 59, 30, 250), "UTC")).toBe(29_750)
  })

  it("uses the device calendar without a zone, and for a zone the runtime rejects", () => {
    const local = new Date(2026, 7, 15, 23, 59, 0).getTime()
    expect(msUntilNextCalendarDay(local)).toBe(60_000)
    expect(calendarDaysBetween(now, lateAug14Utc, "Not/AZone")).toBe(
      calendarDaysBetween(now, lateAug14Utc)
    )
    expect(calendarDayKey(local, "Not/AZone")).toBe(calendarDayKey(local))
  })
})
