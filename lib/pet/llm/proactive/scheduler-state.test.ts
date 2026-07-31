import {
  EMPTY_PROACTIVE_STATE,
  applySpoke,
  localDayKey,
  localHour,
  normalizeProactiveState,
} from "./scheduler-state"

// 2026-06-05T12:00:00Z
const NOON_UTC = Date.UTC(2026, 5, 5, 12, 0, 0)

describe("localDayKey", () => {
  it("renders YYYY-MM-DD in the given timezone", () => {
    expect(localDayKey(NOON_UTC, "UTC")).toBe("2026-06-05")
    // UTC noon is still the previous day in Honolulu? No — 12:00Z = 02:00 HST same day.
    expect(localDayKey(NOON_UTC, "Pacific/Honolulu")).toBe("2026-06-05")
    // 12:00Z = 21:00 in Tokyo, same calendar day.
    expect(localDayKey(NOON_UTC, "Asia/Tokyo")).toBe("2026-06-05")
    // 23:30Z on the 5th is already the 6th in Tokyo.
    expect(localDayKey(Date.UTC(2026, 5, 5, 23, 30), "Asia/Tokyo")).toBe("2026-06-06")
  })
})

describe("localHour", () => {
  it("returns the wall-clock hour (0-23) in the given timezone", () => {
    expect(localHour(NOON_UTC, "UTC")).toBe(12)
    // 12:00Z = 21:00 in Tokyo.
    expect(localHour(NOON_UTC, "Asia/Tokyo")).toBe(21)
    // 12:00Z = 02:00 in Honolulu (UTC-10).
    expect(localHour(NOON_UTC, "Pacific/Honolulu")).toBe(2)
  })

  it("normalizes midnight to 0 rather than 24", () => {
    // 15:00Z = 00:00 next day in Tokyo (UTC+9).
    expect(localHour(Date.UTC(2026, 5, 5, 15, 0), "Asia/Tokyo")).toBe(0)
  })

  it("falls back to the device hour when Intl renders a non-numeric hour", () => {
    const original = Intl.DateTimeFormat
    // @ts-expect-error — force the non-numeric parse path
    Intl.DateTimeFormat = function () {
      return { format: () => "zz" }
    }
    try {
      const result = localHour(NOON_UTC, "UTC")
      expect(Number.isInteger(result)).toBe(true)
      expect(result).toBeGreaterThanOrEqual(0)
      expect(result).toBeLessThanOrEqual(23)
    } finally {
      Intl.DateTimeFormat = original
    }
  })
})

describe("normalizeProactiveState", () => {
  it("returns the empty state for junk", () => {
    expect(normalizeProactiveState(undefined)).toEqual(EMPTY_PROACTIVE_STATE)
    expect(normalizeProactiveState(null)).toEqual(EMPTY_PROACTIVE_STATE)
    expect(normalizeProactiveState("x")).toEqual(EMPTY_PROACTIVE_STATE)
  })

  it("repairs partially-corrupt rows field by field", () => {
    expect(
      normalizeProactiveState({
        lastSpokeAtMs: "soon",
        dayKey: 5,
        spokenToday: -2,
        greetedWindows: ["a", 3, "b"],
      })
    ).toEqual({ lastSpokeAtMs: null, dayKey: null, spokenToday: 0, greetedWindows: ["a", "b"] })
  })
})

describe("applySpoke", () => {
  it("increments within the same day and stamps the clock", () => {
    const first = applySpoke(EMPTY_PROACTIVE_STATE, NOON_UTC, { tz: "UTC" })
    expect(first).toEqual({
      lastSpokeAtMs: NOON_UTC,
      dayKey: "2026-06-05",
      spokenToday: 1,
      greetedWindows: [],
    })
    const second = applySpoke(first, NOON_UTC + 60_000, { tz: "UTC" })
    expect(second.spokenToday).toBe(2)
  })

  it("rolls the day: counter resets and greeted windows clear", () => {
    const yesterday = applySpoke(EMPTY_PROACTIVE_STATE, NOON_UTC, {
      tz: "UTC",
      greetedWindow: "2026-06-05:morning",
    })
    expect(yesterday.greetedWindows).toEqual(["2026-06-05:morning"])

    const tomorrowNoon = NOON_UTC + 24 * 3600_000
    const next = applySpoke(yesterday, tomorrowNoon, { tz: "UTC" })
    expect(next.dayKey).toBe("2026-06-06")
    expect(next.spokenToday).toBe(1)
    expect(next.greetedWindows).toEqual([])
  })

  it("records a greeting window in the same step", () => {
    const s = applySpoke(EMPTY_PROACTIVE_STATE, NOON_UTC, {
      tz: "UTC",
      greetedWindow: "2026-06-05:lateNight",
    })
    expect(s.greetedWindows).toEqual(["2026-06-05:lateNight"])
  })
})
