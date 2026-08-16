import {
  RECENCY_HALF_LIFE_DAYS,
  compareByScore,
  normalizeMessageScore,
  recencyBonus,
  scoreTitleMatch,
  substringPositions,
} from "./scoring"

const NOW = 1_800_000_000_000
const DAY = 86_400_000

describe("scoreTitleMatch", () => {
  it("ranks prefix > word-start > anywhere > secondary > keyword > fuzzy", () => {
    const prefix = scoreTitleMatch("dep", "Deploy notes", { now: NOW })!
    const wordStart = scoreTitleMatch("dep", "Prod deploy", { now: NOW })!
    const anywhere = scoreTitleMatch("dep", "Undeployed", { now: NOW })!
    const secondary = scoreTitleMatch("dep", "Notes", { secondary: "about deploy", now: NOW })!
    const keyword = scoreTitleMatch("dep", "Notes", { keywords: ["deploy"], now: NOW })!
    const fuzzy = scoreTitleMatch("dply", "Deploy", { now: NOW })!
    expect(prefix.score).toBeGreaterThan(wordStart.score)
    expect(wordStart.score).toBeGreaterThan(anywhere.score)
    expect(anywhere.score).toBeGreaterThan(secondary.score)
    expect(secondary.score).toBeGreaterThan(keyword.score)
    expect(keyword.score).toBeGreaterThan(fuzzy.score)
    expect(prefix.field).toBe("title")
    expect(secondary.field).toBe("secondary")
    expect(keyword.field).toBe("keyword")
    expect(prefix.positions).toEqual([0, 1, 2])
    expect(fuzzy.positions).toEqual([0, 2, 3, 5])
  })

  it("returns null when nothing matches, and honours fuzzy=false", () => {
    expect(scoreTitleMatch("zzz", "Deploy", { now: NOW })).toBeNull()
    expect(scoreTitleMatch("dply", "Deploy", { now: NOW, fuzzy: false })).toBeNull()
    expect(scoreTitleMatch("d", "Something else", { now: NOW })).toBeNull()
  })

  it("adds a bounded recency bonus and never exceeds 1", () => {
    const fresh = scoreTitleMatch("dep", "Deploy", { timestamp: NOW, now: NOW })!
    const stale = scoreTitleMatch("dep", "Deploy", { timestamp: NOW - 400 * DAY, now: NOW })!
    expect(fresh.score).toBeGreaterThan(stale.score)
    expect(fresh.score).toBeLessThanOrEqual(1)
    const huge = scoreTitleMatch("deploy", "deploy", {
      timestamp: NOW,
      now: NOW,
      recencyWeight: 5,
    })!
    expect(huge.score).toBe(1)
  })

  it("scores an empty needle neutrally with recency as the tie-breaker", () => {
    const a = scoreTitleMatch("", "A", { timestamp: NOW, now: NOW })!
    const b = scoreTitleMatch("", "B", { timestamp: NOW - 30 * DAY, now: NOW })!
    expect(a.score).toBeGreaterThan(b.score)
    expect(a.positions).toEqual([])
  })
})

describe("helpers", () => {
  it("substringPositions is case-insensitive and empty on miss", () => {
    expect(substringPositions("Hello World", "wor")).toEqual([6, 7, 8])
    expect(substringPositions("Hello", "xyz")).toEqual([])
  })

  it("recencyBonus halves per half-life and is 0 for missing timestamps", () => {
    expect(recencyBonus(undefined, NOW)).toBe(0)
    expect(recencyBonus(Number.NaN, NOW)).toBe(0)
    expect(recencyBonus(NOW, NOW)).toBe(1)
    expect(recencyBonus(NOW - RECENCY_HALF_LIFE_DAYS * DAY, NOW)).toBeCloseTo(0.5)
    expect(recencyBonus(NOW + DAY, NOW)).toBe(1)
  })

  it("normalizeMessageScore clamps to [0, 1]", () => {
    expect(normalizeMessageScore(-1)).toBe(0)
    expect(normalizeMessageScore(Number.NaN)).toBe(0)
    expect(normalizeMessageScore(1.8)).toBeCloseTo(0.5)
    expect(normalizeMessageScore(99)).toBe(1)
  })

  it("compareByScore orders by score, then recency, then title", () => {
    const rows = [
      { title: "b", score: 0.5, timestamp: 1 },
      { title: "a", score: 0.5, timestamp: 1 },
      { title: "c", score: 0.5, timestamp: 9 },
      { title: "d", score: 0.9 },
    ]
    expect([...rows].sort(compareByScore).map((r) => r.title)).toEqual(["d", "c", "a", "b"])
  })
})
