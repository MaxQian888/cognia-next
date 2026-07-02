import { advanceStreak, coinMultiplier, computeStreakFromLedger, localDayKey } from "./streak"

/** Local-noon epoch for a YYYY-MM-DD day (keeps tests DST-safe). */
function atNoon(day: string): number {
  return new Date(`${day}T12:00:00`).getTime()
}

describe("localDayKey", () => {
  it("formats the local calendar day", () => {
    expect(localDayKey(atNoon("2026-07-02"))).toBe("2026-07-02")
    // 23:59 and next-day 00:01 land on different days.
    expect(localDayKey(new Date("2026-07-02T23:59:00").getTime())).toBe("2026-07-02")
    expect(localDayKey(new Date("2026-07-03T00:01:00").getTime())).toBe("2026-07-03")
  })
})

describe("advanceStreak", () => {
  it("starts at 1 on the first ever interaction", () => {
    expect(advanceStreak(undefined, atNoon("2026-07-02"))).toEqual({
      days: 1,
      lastDay: "2026-07-02",
    })
  })

  it("is idempotent within the same day", () => {
    const s = { days: 4, lastDay: "2026-07-02" }
    expect(advanceStreak(s, atNoon("2026-07-02"))).toEqual(s)
  })

  it("increments when the last counted day was yesterday", () => {
    expect(advanceStreak({ days: 4, lastDay: "2026-07-01" }, atNoon("2026-07-02"))).toEqual({
      days: 5,
      lastDay: "2026-07-02",
    })
  })

  it("counts a just-past-midnight interaction as the next day", () => {
    const s = advanceStreak(
      { days: 1, lastDay: "2026-07-02" },
      new Date("2026-07-03T00:01:00").getTime()
    )
    expect(s).toEqual({ days: 2, lastDay: "2026-07-03" })
  })

  it("resets to 1 after a gap", () => {
    expect(advanceStreak({ days: 9, lastDay: "2026-06-28" }, atNoon("2026-07-02"))).toEqual({
      days: 1,
      lastDay: "2026-07-02",
    })
  })

  it("normalizes garbage input before advancing", () => {
    expect(advanceStreak({ days: Number.NaN, lastDay: null }, atNoon("2026-07-02"))).toEqual({
      days: 1,
      lastDay: "2026-07-02",
    })
  })
})

describe("coinMultiplier", () => {
  it.each([
    [0, 1],
    [2, 1],
    [3, 1.25],
    [6, 1.25],
    [7, 1.5],
    [29, 1.5],
    [30, 2],
    [365, 2],
  ])("%i days → ×%s", (days, mult) => {
    expect(coinMultiplier(days)).toBe(mult)
  })

  it("treats non-finite input as no multiplier", () => {
    expect(coinMultiplier(Number.NaN)).toBe(1)
  })
})

describe("computeStreakFromLedger", () => {
  const KINDS = new Set(["fed", "played", "petted", "talked", "slept", "cleaned", "treated"])

  it("returns the zero streak for an empty or interaction-free ledger", () => {
    expect(computeStreakFromLedger([], KINDS)).toEqual({ days: 0, lastDay: null })
    expect(
      computeStreakFromLedger(
        [{ kind: "goalComplete", source: "goal", ts: atNoon("2026-07-01") }],
        KINDS
      )
    ).toEqual({ days: 0, lastDay: null })
  })

  it("counts the consecutive-day run ending at the most recent interaction day", () => {
    const rows = [
      { kind: "fed", source: "user", ts: atNoon("2026-06-28") },
      // gap on 06-29
      { kind: "played", source: "user", ts: atNoon("2026-06-30") },
      { kind: "fed", source: "user", ts: atNoon("2026-07-01") },
      { kind: "petted", source: "user", ts: atNoon("2026-07-02") },
    ]
    expect(computeStreakFromLedger(rows, KINDS)).toEqual({ days: 3, lastDay: "2026-07-02" })
  })

  it("ignores non-user rows even for interaction kinds", () => {
    const rows = [
      { kind: "fed", source: "workflow", ts: atNoon("2026-07-01") },
      { kind: "fed", source: "user", ts: atNoon("2026-07-02") },
    ]
    expect(computeStreakFromLedger(rows, KINDS)).toEqual({ days: 1, lastDay: "2026-07-02" })
  })

  it("dedupes multiple interactions on the same day", () => {
    const rows = [
      { kind: "fed", source: "user", ts: atNoon("2026-07-02") },
      { kind: "played", source: "user", ts: new Date("2026-07-02T18:00:00").getTime() },
    ]
    expect(computeStreakFromLedger(rows, KINDS)).toEqual({ days: 1, lastDay: "2026-07-02" })
  })
})
