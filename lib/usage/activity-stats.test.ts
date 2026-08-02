import type { SessionUsageRow } from "@/lib/db/session-usage"
import { collectActivityStats, EMPTY_ACTIVITY_STATS } from "./activity-stats"

/**
 * Timestamps are built from LOCAL date parts on purpose — `localDay` buckets by
 * the user's calendar, so a UTC-constructed fixture would shift days (and break
 * streaks) on any machine that isn't at UTC+0.
 */
function at(day: number, hour = 10): number {
  return new Date(2026, 4, day, hour, 0, 0).getTime()
}

const NOW = at(20, 12)

function row(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `m-${Math.random()}`,
    sessionId: "s1",
    at: NOW,
    model: "sonnet",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 20,
    // Non-zero so `effectiveCostUsd` takes the SDK figure and never touches the
    // pricing tables — this suite is about aggregation, not pricing.
    costUsd: 0.01,
    durationMs: 1000,
    ...overrides,
  }
}

describe("collectActivityStats", () => {
  it("returns the zero shape for no rows", () => {
    expect(collectActivityStats([])).toEqual(EMPTY_ACTIVITY_STATS)
  })

  it("returns a fresh object each time so callers cannot mutate the shared empty", () => {
    const a = collectActivityStats([])
    a.turns = 99
    expect(collectActivityStats([]).turns).toBe(0)
    expect(EMPTY_ACTIVITY_STATS.turns).toBe(0)
  })

  it("sums turns, sessions, tokens, cost and duration", () => {
    const stats = collectActivityStats(
      [
        row({ messageId: "a" }),
        row({ messageId: "b", sessionId: "s2", durationMs: 500, costUsd: 0.02 }),
        row({ messageId: "c", sessionId: "s2" }),
      ],
      { now: NOW }
    )
    expect(stats.turns).toBe(3)
    expect(stats.sessions).toBe(2)
    // input + output + cacheRead per row (cache *creation* is excluded, matching
    // `aggregateByDay`'s `tokens`).
    expect(stats.totalTokens).toBe(3 * 170)
    expect(stats.costUsd).toBeCloseTo(0.04)
    expect(stats.durationMs).toBe(2500)
  })

  it("counts distinct LOCAL calendar days as active days", () => {
    const stats = collectActivityStats(
      [
        row({ messageId: "a", at: at(18, 1) }),
        row({ messageId: "b", at: at(18, 23) }),
        row({ messageId: "c", at: at(20) }),
      ],
      { now: NOW }
    )
    expect(stats.activeDays).toBe(2)
  })

  describe("streaks", () => {
    it("counts consecutive days ending today", () => {
      const stats = collectActivityStats(
        [
          row({ messageId: "a", at: at(18) }),
          row({ messageId: "b", at: at(19) }),
          row({ messageId: "c", at: at(20) }),
        ],
        { now: NOW }
      )
      expect(stats.currentStreak).toBe(3)
      expect(stats.longestStreak).toBe(3)
    })

    it("keeps a streak alive through today when only yesterday has usage", () => {
      const stats = collectActivityStats(
        [row({ messageId: "a", at: at(18) }), row({ messageId: "b", at: at(19) })],
        { now: NOW }
      )
      expect(stats.currentStreak).toBe(2)
    })

    it("reports no current streak once two days have passed", () => {
      const stats = collectActivityStats([row({ messageId: "a", at: at(17) })], { now: NOW })
      expect(stats.currentStreak).toBe(0)
      expect(stats.longestStreak).toBe(1)
    })

    it("finds the longest run when it is not the current one", () => {
      const stats = collectActivityStats(
        [
          // 4-day run, a gap, then today alone.
          row({ messageId: "a", at: at(10) }),
          row({ messageId: "b", at: at(11) }),
          row({ messageId: "c", at: at(12) }),
          row({ messageId: "d", at: at(13) }),
          row({ messageId: "e", at: at(20) }),
        ],
        { now: NOW }
      )
      expect(stats.currentStreak).toBe(1)
      expect(stats.longestStreak).toBe(4)
    })

    it("steps whole calendar days across a month boundary", () => {
      // Apr 30 → May 1 → May 2 is one unbroken run: stepping by `Date`
      // arithmetic (not by 86_400_000ms) is what makes the month roll over.
      const stats = collectActivityStats(
        [
          row({ messageId: "a", at: new Date(2026, 3, 30, 9).getTime() }),
          row({ messageId: "b", at: new Date(2026, 4, 1, 9).getTime() }),
          row({ messageId: "c", at: new Date(2026, 4, 2, 9).getTime() }),
        ],
        { now: new Date(2026, 4, 2, 20).getTime() }
      )
      expect(stats.currentStreak).toBe(3)
      expect(stats.longestStreak).toBe(3)
      // Apr 29 is absent, so the run must stop there rather than run on.
      expect(stats.activeDays).toBe(3)
    })
  })

  describe("peak hour", () => {
    it("picks the local hour with the most turns", () => {
      const stats = collectActivityStats(
        [
          row({ messageId: "a", at: at(19, 9) }),
          row({ messageId: "b", at: at(20, 19) }),
          row({ messageId: "c", at: at(19, 19) }),
        ],
        { now: NOW }
      )
      expect(stats.peakHour).toBe(19)
    })

    it("breaks ties toward the earlier hour", () => {
      const stats = collectActivityStats(
        [row({ messageId: "a", at: at(20, 3) }), row({ messageId: "b", at: at(20, 21) })],
        { now: NOW }
      )
      expect(stats.peakHour).toBe(3)
    })
  })

  it("names the model with the most tokens as the top model", () => {
    const stats = collectActivityStats(
      [
        row({ messageId: "a", model: "haiku", inputTokens: 10, outputTokens: 5 }),
        row({ messageId: "b", model: "opus", inputTokens: 900, outputTokens: 900 }),
      ],
      { now: NOW }
    )
    expect(stats.topModel).toBe("opus")
  })

  it("defaults to the real clock when no `now` is injected", () => {
    // A turn recorded "just now" must count as today's streak without the
    // caller having to supply a clock.
    const stats = collectActivityStats([row({ messageId: "a", at: Date.now() })])
    expect(stats.currentStreak).toBe(1)
    expect(stats.activeDays).toBe(1)
  })

  it("prices turns the SDK left at zero through the injected resolver", () => {
    const stats = collectActivityStats(
      [row({ messageId: "a", costUsd: 0, inputTokens: 1_000_000, outputTokens: 0 })],
      { now: NOW, resolve: () => ({ promptPer1M: 3, completionPer1M: 15 }) }
    )
    expect(stats.costUsd).toBeCloseTo(3)
  })
})
