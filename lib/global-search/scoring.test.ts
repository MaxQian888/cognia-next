import {
  MATCH_TIER_BANDS,
  MATCH_TIER_ORDER,
  MESSAGE_SCORE_BAND,
  RECENCY_HALF_LIFE_DAYS,
  TIER_GAP,
  compareByScore,
  matchTierOfScore,
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

  it("rejects scattered subsequences that only match one letter at a time", () => {
    expect(scoreTitleMatch("sett", "Subworkflow orchestrator", { now: NOW })).toBeNull()
    expect(scoreTitleMatch("dply", "Deploy", { now: NOW })).not.toBeNull()
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

  it("normalizeMessageScore maps into the message band and saturates at its top", () => {
    const [floor, ceiling] = MESSAGE_SCORE_BAND
    expect(normalizeMessageScore(-1)).toBe(0)
    expect(normalizeMessageScore(Number.NaN)).toBe(0)
    expect(normalizeMessageScore(1.8)).toBeCloseTo(floor + (ceiling - floor) / 2)
    expect(normalizeMessageScore(99)).toBe(ceiling)
    // A message body hit never reads as a word-start, prefix or exact title.
    expect(matchTierOfScore(normalizeMessageScore(99))).toBe("substring")
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

describe('match tiers (⌘K "memory" regression)', () => {
  const fresh = { timestamp: NOW, now: NOW }
  const stale = { timestamp: NOW - 365 * DAY, now: NOW }

  it("keeps every band disjoint and at least TIER_GAP apart, strongest highest", () => {
    for (let i = 1; i < MATCH_TIER_ORDER.length; i++) {
      const stronger = MATCH_TIER_BANDS[MATCH_TIER_ORDER[i - 1]!]
      const weaker = MATCH_TIER_BANDS[MATCH_TIER_ORDER[i]!]
      expect(stronger[0] - weaker[1]).toBeGreaterThanOrEqual(TIER_GAP - 1e-9)
    }
  })

  it("an exact title outranks a fresh prefix title, whatever the recency", () => {
    const page = scoreTitleMatch("memory", "Memory", stale)!
    const chat = scoreTitleMatch("memory", "Memory leak in worker", fresh)!
    expect(page.tier).toBe("exact")
    expect(chat.tier).toBe("prefix")
    expect(page.score).toBeGreaterThan(chat.score)
  })

  it("recency never lifts an item into a stronger tier", () => {
    const prefixStale = scoreTitleMatch("mem", "Memo board", stale)!
    const wordFresh = scoreTitleMatch("mem", "In memory", {
      ...fresh,
      recencyWeight: 50,
    })!
    const substringFresh = scoreTitleMatch("memory", "inmemory cache", fresh)!
    expect(prefixStale.score).toBeGreaterThan(wordFresh.score)
    expect(wordFresh.score).toBeGreaterThan(substringFresh.score)
    expect(matchTierOfScore(wordFresh.score)).toBe("word")
  })

  it('an exact keyword is a strong match: the zh-CN page "记忆" found by "memory"', () => {
    const page = scoreTitleMatch("memory", "记忆", { keywords: ["memory", "/memory"], ...stale })!
    const chat = scoreTitleMatch("memory", "Memory leak in worker", fresh)!
    expect(page.tier).toBe("keyword-exact")
    expect(page.field).toBe("keyword")
    expect(page.score).toBeGreaterThan(chat.score)
    // …but never above a title that IS the query.
    const exact = scoreTitleMatch("memory", "Memory", stale)!
    expect(exact.score).toBeGreaterThan(page.score)
  })

  it("prefers the strongest field and keeps the title highlight when a keyword wins", () => {
    const hit = scoreTitleMatch("deploy", "Deploy notes", { keywords: ["deploy"], now: NOW })!
    expect(hit.tier).toBe("keyword-exact")
    expect(hit.positions).toEqual([0, 1, 2, 3, 4, 5])
    const weak = scoreTitleMatch("dep", "Deploy notes", { keywords: ["dependency"], now: NOW })!
    expect(weak.tier).toBe("prefix")
    expect(weak.field).toBe("title")
  })

  it("orders keyword prefix and keyword substring below secondary text", () => {
    const secondary = scoreTitleMatch("dep", "Notes", { secondary: "about deploy", now: NOW })!
    const keywordPrefix = scoreTitleMatch("dep", "Notes", { keywords: ["deploy"], now: NOW })!
    const keywordAnywhere = scoreTitleMatch("dep", "Notes", { keywords: ["undeploy"], now: NOW })!
    expect(keywordPrefix.tier).toBe("keyword-prefix")
    expect(keywordAnywhere.tier).toBe("keyword")
    expect(secondary.score).toBeGreaterThan(keywordPrefix.score)
    expect(keywordPrefix.score).toBeGreaterThan(keywordAnywhere.score)
  })

  it("keeps fuzzy guesses below every literal match", () => {
    const fuzzy = scoreTitleMatch("mmry", "Memory", { ...fresh, recencyWeight: 50 })!
    const keyword = scoreTitleMatch("memory", "Notes", { keywords: ["inmemory"], ...stale })!
    expect(fuzzy.tier).toBe("fuzzy")
    expect(keyword.score).toBeGreaterThan(fuzzy.score)
  })

  it("reads a provider-nudged score back as its tier", () => {
    const prefix = scoreTitleMatch("dep", "Deploy", fresh)!
    // actions.ts boosts primary commands by 0.03; settings demotes controls by 0.02.
    expect(matchTierOfScore(Math.min(1, prefix.score + 0.03))).toBe("prefix")
    expect(matchTierOfScore(prefix.score - 0.02)).toBe("prefix")
    const keywordExact = scoreTitleMatch("x", "Y", { keywords: ["x"], ...fresh })!
    expect(matchTierOfScore(keywordExact.score + 0.03)).toBe("keyword-exact")
  })
})
