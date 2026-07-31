import { formatTurnTime } from "./format-turn-time"

const LOCALE = "en-US"
const YESTERDAY = "Yesterday"

// Build local-time dates so day-diff math is timezone-independent.
function at(year: number, month0: number, day: number, h = 14, min = 32): number {
  return new Date(year, month0, day, h, min).getTime()
}

const NOW = at(2026, 5, 24) // 2026-06-24 14:32 local

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })
}

function fmt(ms: number | undefined): string {
  return formatTurnTime(ms, { now: NOW, yesterdayLabel: YESTERDAY, locale: LOCALE })
}

describe("formatTurnTime", () => {
  it("returns empty string for missing or non-finite input", () => {
    expect(fmt(undefined)).toBe("")
    expect(fmt(Number.NaN)).toBe("")
    expect(fmt(Number.POSITIVE_INFINITY)).toBe("")
  })

  it("shows only HH:MM for a same-day turn", () => {
    const ms = at(2026, 5, 24, 9, 5)
    expect(fmt(ms)).toBe(clock(ms))
  })

  it("prefixes the injected label for a turn from yesterday", () => {
    const ms = at(2026, 5, 23, 18, 0)
    expect(fmt(ms)).toBe(`${YESTERDAY} ${clock(ms)}`)
  })

  it("uses a short weekday for turns within the last week", () => {
    const ms = at(2026, 5, 21, 8, 15) // 3 days ago
    const weekday = new Date(ms).toLocaleDateString(LOCALE, { weekday: "short" })
    expect(fmt(ms)).toBe(`${weekday} ${clock(ms)}`)
    expect(fmt(ms).startsWith(weekday)).toBe(true)
  })

  it("uses month/day without a year for older same-year turns", () => {
    const ms = at(2026, 0, 5, 10, 0) // Jan 5, same year
    const out = fmt(ms)
    expect(out).toContain(clock(ms))
    // No 4-digit year when the year matches "now".
    expect(out).not.toMatch(/\b\d{4}\b/)
    expect(out).toContain(
      new Date(ms).toLocaleDateString(LOCALE, { month: "short", day: "numeric" })
    )
  })

  it("includes the year for turns in a different year", () => {
    const ms = at(2024, 10, 2, 12, 0) // Nov 2, 2024
    const out = fmt(ms)
    expect(out).toContain("2024")
    expect(out).toContain(clock(ms))
  })

  it("falls back to an explicit date for future timestamps", () => {
    const ms = at(2026, 6, 1, 9, 0) // next month, after NOW
    const out = fmt(ms)
    expect(out).toContain(clock(ms))
    expect(out).toContain(
      new Date(ms).toLocaleDateString(LOCALE, { month: "short", day: "numeric" })
    )
  })

  it("defaults `now` to the current time when omitted", () => {
    // A timestamp from "right now" should render as same-day HH:MM only.
    const ms = Date.now()
    const out = formatTurnTime(ms, { yesterdayLabel: YESTERDAY, locale: LOCALE })
    expect(out).toBe(
      new Date(ms).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })
    )
  })
})
