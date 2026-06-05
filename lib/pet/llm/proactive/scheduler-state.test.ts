import {
  EMPTY_PROACTIVE_STATE,
  applySpoke,
  localDayKey,
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
