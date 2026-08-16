import {
  CONVERSATION_TIMESTAMP_FORMATS,
  conversationTimestampShape,
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
