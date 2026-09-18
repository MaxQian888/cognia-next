// Coverage for quiet-hours evaluation (V2): same-day and cross-midnight
// windows, the deferred-release instant landing on the NEXT wall-clock `end`
// in the target's zone (DST-safe via Intl), critical-level bypass, malformed
// and zero-length windows. Pure functions — no Dexie.

import {
  isInQuietHours,
  quietHoursReleaseAt,
  evaluateQuietHours,
  type QuietHoursWindow,
} from "./quiet-hours"

const TZ = "America/New_York"

/**
 * Build the UTC instant of a New York wall-clock `date HH:mm`. Resolves the
 * zone's UTC offset at that wall-clock via `Intl` (longOffset), so it is
 * correct across DST — March 10 2026 is EDT (UTC-4), before March 8 EST (-5).
 */
function nyInstant(date: string, hhmm: string): number {
  const utcGuess = Date.parse(`${date}T${hhmm}:00Z`)
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(utcGuess))
    .find((p) => p.type === "timeZoneName")?.value
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(offsetName ?? "GMT-4")
  const sign = m?.[1] === "-" ? -1 : 1
  const offMin = sign * (Number(m?.[2] ?? 4) * 60 + Number(m?.[3] ?? 0))
  return utcGuess - offMin * 60 * 1000
}

const wrap: QuietHoursWindow = { enabled: true, start: "22:00", end: "08:00" }
const sameDay: QuietHoursWindow = { enabled: true, start: "13:00", end: "17:00" }

describe("isInQuietHours", () => {
  it("returns false when disabled", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    expect(isInQuietHours(instant, { ...wrap, enabled: false }, TZ)).toBe(false)
  })

  it("detects a cross-midnight window — late night side", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    expect(isInQuietHours(instant, wrap, TZ)).toBe(true)
  })

  it("detects a cross-midnight window — early morning side", () => {
    const instant = nyInstant("2026-03-10", "06:15")
    expect(isInQuietHours(instant, wrap, TZ)).toBe(true)
  })

  it("is outside a cross-midnight window during the day", () => {
    const instant = nyInstant("2026-03-10", "12:00")
    expect(isInQuietHours(instant, wrap, TZ)).toBe(false)
  })

  it("respects the window boundaries (start inclusive, end exclusive)", () => {
    expect(isInQuietHours(nyInstant("2026-03-10", "22:00"), wrap, TZ)).toBe(true)
    expect(isInQuietHours(nyInstant("2026-03-10", "08:00"), wrap, TZ)).toBe(false)
    expect(isInQuietHours(nyInstant("2026-03-10", "07:59"), wrap, TZ)).toBe(true)
  })

  it("handles a same-day window", () => {
    expect(isInQuietHours(nyInstant("2026-03-10", "14:00"), sameDay, TZ)).toBe(true)
    expect(isInQuietHours(nyInstant("2026-03-10", "18:00"), sameDay, TZ)).toBe(false)
    expect(isInQuietHours(nyInstant("2026-03-10", "09:00"), sameDay, TZ)).toBe(false)
  })

  it("treats a zero-length window as never quiet", () => {
    const zero: QuietHoursWindow = { enabled: true, start: "08:00", end: "08:00" }
    expect(isInQuietHours(nyInstant("2026-03-10", "08:00"), zero, TZ)).toBe(false)
    expect(isInQuietHours(nyInstant("2026-03-10", "20:00"), zero, TZ)).toBe(false)
  })

  it("returns false on malformed bounds", () => {
    const bad: QuietHoursWindow = { enabled: true, start: "bad", end: "08:00" }
    expect(isInQuietHours(nyInstant("2026-03-10", "23:00"), bad, TZ)).toBe(false)
  })
})

describe("quietHoursReleaseAt", () => {
  it("releases at the NEXT wall-clock end — same night", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    const release = quietHoursReleaseAt(instant, wrap, TZ)
    // The release should be 08:00 the following day in New York.
    const releaseParts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(release))
    const hh = Number(releaseParts.find((p) => p.type === "hour")?.value)
    const mm = Number(releaseParts.find((p) => p.type === "minute")?.value)
    expect(hh).toBe(8)
    expect(mm).toBe(0)
    expect(release).toBeGreaterThan(instant)
  })

  it("releases at the NEXT wall-clock end — early morning", () => {
    const instant = nyInstant("2026-03-10", "06:00")
    const release = quietHoursReleaseAt(instant, wrap, TZ)
    expect(release).toBeGreaterThan(instant)
    // 08:00 same day.
    expect(release - instant).toBeLessThanOrEqual(3 * 60 * 60 * 1000)
  })
})

describe("evaluateQuietHours", () => {
  it("defers a non-critical fact inside the window", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    const r = evaluateQuietHours({
      instant,
      window: wrap,
      timezone: TZ,
      level: "warning",
      allowCritical: true,
    })
    expect(r.deferred).toBe(true)
    expect(r.releaseAt).toBeGreaterThan(instant)
  })

  it("does not defer a critical fact when bypass is allowed", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    const r = evaluateQuietHours({
      instant,
      window: wrap,
      timezone: TZ,
      level: "critical",
      allowCritical: true,
    })
    expect(r.deferred).toBe(false)
  })

  it("still defers a critical fact when bypass is disallowed", () => {
    const instant = nyInstant("2026-03-10", "23:30")
    const r = evaluateQuietHours({
      instant,
      window: wrap,
      timezone: TZ,
      level: "critical",
      allowCritical: false,
    })
    expect(r.deferred).toBe(true)
  })

  it("does not defer outside the window", () => {
    const instant = nyInstant("2026-03-10", "12:00")
    const r = evaluateQuietHours({
      instant,
      window: wrap,
      timezone: TZ,
      level: "warning",
      allowCritical: true,
    })
    expect(r.deferred).toBe(false)
  })
})
