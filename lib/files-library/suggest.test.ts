import {
  SUGGESTION_FAVORITE_BONUS,
  SUGGESTION_RECENT_OPEN_BONUS,
  SUGGESTION_RECENT_OPEN_WINDOW_MS,
  suggestionScore,
} from "./suggest"

const DAY = 24 * 60 * 60 * 1000
const NOW = 500 * DAY

type Scored = Parameters<typeof suggestionScore>[0]

function item(overrides: Partial<Scored> = {}): Scored {
  return { updatedAt: NOW, sessionIds: [], ...overrides }
}

describe("suggestionScore", () => {
  it("scores an item touched just now with no other signal at ~1", () => {
    expect(suggestionScore(item(), NOW)).toBeCloseTo(1, 10)
  })

  it("ranks newer items above older ones", () => {
    const today = suggestionScore(item({ updatedAt: NOW }), NOW)
    const lastWeek = suggestionScore(item({ updatedAt: NOW - 7 * DAY }), NOW)
    const lastMonth = suggestionScore(item({ updatedAt: NOW - 30 * DAY }), NOW)
    expect(today).toBeGreaterThan(lastWeek)
    expect(lastWeek).toBeGreaterThan(lastMonth)
    expect(lastMonth).toBeGreaterThan(0)
    expect(lastMonth).toBeLessThan(0.15)
  })

  it("treats a future timestamp as now rather than above 1", () => {
    expect(suggestionScore(item({ updatedAt: NOW + DAY }), NOW)).toBeCloseTo(1, 10)
  })

  it("uses the newest of open and change for recency", () => {
    const stale = item({ updatedAt: NOW - 60 * DAY })
    const reopened = item({ updatedAt: NOW - 60 * DAY, lastAccessedAt: NOW - 30 * DAY })
    expect(suggestionScore(reopened, NOW)).toBeGreaterThan(suggestionScore(stale, NOW))
  })

  it("ranks items in more conversations above those in fewer, with diminishing returns", () => {
    const sessions = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)
    const zero = suggestionScore(item({ sessionIds: sessions(0) }), NOW)
    const one = suggestionScore(item({ sessionIds: sessions(1) }), NOW)
    const three = suggestionScore(item({ sessionIds: sessions(3) }), NOW)
    const seven = suggestionScore(item({ sessionIds: sessions(7) }), NOW)
    expect(one).toBeGreaterThan(zero)
    expect(three).toBeGreaterThan(one)
    expect(seven).toBeGreaterThan(three)
    // log2: 0→1 and 1→3 and 3→7 each add the same step.
    expect(three - one).toBeCloseTo(one - zero, 10)
    expect(seven - three).toBeCloseTo(one - zero, 10)
  })

  it("adds the favorite bonus", () => {
    const plain = suggestionScore(item(), NOW)
    expect(suggestionScore(item({ favoritedAt: 1 }), NOW) - plain).toBeCloseTo(
      SUGGESTION_FAVORITE_BONUS,
      10
    )
    // favoritedAt 0 still counts as a favorite.
    expect(suggestionScore(item({ favoritedAt: 0 }), NOW) - plain).toBeCloseTo(
      SUGGESTION_FAVORITE_BONUS,
      10
    )
  })

  it("adds the recent-open bonus only for an open within the last week", () => {
    const updatedAt = NOW - 30 * DAY
    const lastAccessedAt = NOW - SUGGESTION_RECENT_OPEN_WINDOW_MS
    const inside = suggestionScore(item({ updatedAt, lastAccessedAt }), NOW)
    const outside = suggestionScore(item({ updatedAt, lastAccessedAt: lastAccessedAt - 1 }), NOW)
    // Both opens give nearly the same recency; only the bonus separates them.
    expect(inside - outside).toBeCloseTo(SUGGESTION_RECENT_OPEN_BONUS, 6)
    expect(SUGGESTION_RECENT_OPEN_WINDOW_MS).toBe(7 * DAY)
  })

  it("does not give the open bonus to an item that was only changed", () => {
    const changed = suggestionScore(item({ updatedAt: NOW }), NOW)
    const opened = suggestionScore(item({ updatedAt: NOW, lastAccessedAt: NOW }), NOW)
    expect(opened - changed).toBeCloseTo(SUGGESTION_RECENT_OPEN_BONUS, 10)
  })
})
