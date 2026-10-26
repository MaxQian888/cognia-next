import { DEFAULT_STREAK, normalizeCoins, normalizeStreak } from "./economy"

describe("normalizeStreak", () => {
  it("defaults absent/null input to the zero streak", () => {
    expect(normalizeStreak(undefined)).toEqual(DEFAULT_STREAK)
    expect(normalizeStreak(null)).toEqual(DEFAULT_STREAK)
    expect(normalizeStreak({})).toEqual({ days: 0, lastDay: null })
  })

  it("floors fractional days and clamps negatives to 0", () => {
    expect(normalizeStreak({ days: 3.9, lastDay: "2026-07-01" }).days).toBe(3)
    expect(normalizeStreak({ days: -2, lastDay: "2026-07-01" }).days).toBe(0)
  })

  it("drops non-finite days and empty lastDay strings", () => {
    expect(normalizeStreak({ days: Number.NaN }).days).toBe(0)
    expect(normalizeStreak({ days: Infinity }).days).toBe(0)
    expect(normalizeStreak({ days: 1, lastDay: "" }).lastDay).toBeNull()
  })

  it("passes through a valid streak unchanged", () => {
    expect(normalizeStreak({ days: 7, lastDay: "2026-07-02" })).toEqual({
      days: 7,
      lastDay: "2026-07-02",
    })
  })
})

describe("normalizeCoins", () => {
  it("defaults absent/garbage to 0", () => {
    expect(normalizeCoins(undefined)).toBe(0)
    expect(normalizeCoins(null)).toBe(0)
    expect(normalizeCoins(Number.NaN)).toBe(0)
    expect(normalizeCoins(-5)).toBe(0)
  })

  it("floors to a whole coin count", () => {
    expect(normalizeCoins(12.9)).toBe(12)
    expect(normalizeCoins(42)).toBe(42)
  })
})
