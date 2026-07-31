import { formatAccountDate } from "./format-account-date"

describe("formatAccountDate", () => {
  it("formats a timestamp as a short localized date", () => {
    // Mid-day UTC keeps the calendar date stable across time zones (±14h).
    const ts = Date.UTC(2024, 0, 15, 12)
    expect(formatAccountDate(ts, "en-US")).toBe("Jan 15, 2024")
  })

  it("returns a non-empty string for the default locale", () => {
    expect(formatAccountDate(Date.UTC(2024, 5, 1, 12)).length).toBeGreaterThan(0)
  })
})
