import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { PricingResolver } from "./session-analytics"
import { summarizeSpend } from "./usage-report"
import {
  OTHER_SERIES_KEY,
  buildActivityMatrix,
  buildDailyStack,
  compareSpend,
  detectSpendSpikes,
  estimateCacheSavings,
  forecastMonthSpend,
  forecastQueryStart,
  projectedLimitCrossing,
  summarizeTurnDistribution,
} from "./usage-insights"

// Local-time anchors: every window in this module is cut at LOCAL midnight.
const NOW = new Date(2026, 4, 20, 12, 0, 0).getTime()
const DAY = 86_400_000

function at(daysBack: number, hour = 12): number {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysBack)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

let seq = 0
function row(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  seq += 1
  return {
    messageId: `m-${seq}`,
    sessionId: "s1",
    at: NOW,
    model: "test-model",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 1,
    costSource: "sdk",
    costKnown: true,
    durationMs: 1000,
    ...overrides,
  }
}

const unpriced = (o: Partial<SessionUsageRow> = {}) =>
  row({ costUsd: 0, costSource: "unknown", costKnown: false, ...o })

const priceFor: PricingResolver = (_p, model) =>
  model === "test-model" ? { promptPer1M: 3, completionPer1M: 15, cachedInputPer1M: 0.3 } : null

describe("compareSpend", () => {
  it("reports relative changes against the previous window", () => {
    const current = summarizeSpend([row({ costUsd: 3 }), row({ costUsd: 3 })])
    const previous = summarizeSpend([row({ costUsd: 2 }), row({ costUsd: 2 })])
    const change = compareSpend(current, previous)
    expect(change.cost).toBeCloseTo(0.5)
    expect(change.turns).toBe(0)
    expect(change.tokens).toBe(0)
    expect(change.costPerTurn).toBeCloseTo(0.5)
    expect(change.speed).toBe(0)
  })

  it("compares output speed only when both windows were timed", () => {
    const fast = summarizeSpend([row({ outputTokens: 200, durationMs: 1000 })])
    const slow = summarizeSpend([row({ outputTokens: 100, durationMs: 1000 })])
    expect(compareSpend(fast, slow).speed).toBeCloseTo(1)
    expect(compareSpend(fast, summarizeSpend([row({ durationMs: 0 })])).speed).toBeNull()
  })

  it("refuses to compare costs when either window is a lower bound", () => {
    const current = summarizeSpend([row({ costUsd: 3 }), unpriced()])
    const previous = summarizeSpend([row({ costUsd: 2 })])
    const change = compareSpend(current, previous)
    expect(change.cost).toBeNull()
    expect(change.costPerTurn).toBeNull()
    expect(change.turns).toBe(1)
  })

  it("has no change when the previous window was empty", () => {
    const change = compareSpend(summarizeSpend([row()]), summarizeSpend([]))
    expect(change).toEqual({
      cost: null,
      tokens: null,
      turns: null,
      costPerTurn: null,
      cacheHitPoints: null,
      speed: null,
    })
  })

  it("expresses the cache-hit change in percentage points", () => {
    const current = summarizeSpend([row({ inputTokens: 500, cacheReadTokens: 500 })])
    const previous = summarizeSpend([row({ inputTokens: 750, cacheReadTokens: 250 })])
    expect(compareSpend(current, previous).cacheHitPoints).toBeCloseTo(25)
  })
})

describe("forecastMonthSpend", () => {
  it("extrapolates the trailing seven-day rate over the rest of the month", () => {
    // $7 over the trailing window, one turn per day for 8 days.
    const rows = Array.from({ length: 8 }, (_, i) => row({ at: at(i, 9) }))
    const f = forecastMonthSpend(rows, NOW)
    expect(f.basis).toBe("trailing-7d")
    expect(f.monthToDateUsd).toBe(8)
    // The window is 6.5 days long (today is half over) and holds 7 turns.
    expect(f.rateWindowDays).toBeCloseTo(6.5)
    expect(f.dailyRunRateUsd).toBeCloseTo(7 / 6.5)
    const remaining = (f.monthEnd - NOW) / DAY
    expect(f.projectedMonthUsd).toBeCloseTo(8 + (7 / 6.5) * remaining)
  })

  it("measures from first use when that is newer than seven days", () => {
    const rows = [row({ at: at(2, 8) }), row({ at: at(0, 8) })]
    const f = forecastMonthSpend(rows, NOW)
    expect(f.basis).toBe("since-first-use")
    expect(f.rateWindowDays).toBeCloseTo(2.5)
  })

  it("does not extrapolate from less than a day of history", () => {
    const f = forecastMonthSpend([row({ at: at(0, 9) })], NOW)
    expect(f.dailyRunRateUsd).toBeNull()
    expect(f.projectedMonthUsd).toBeNull()
    expect(f.basis).toBeNull()
    expect(f.monthToDateUsd).toBe(1)
  })

  it("excludes imported spend and counts unpriced turns as a floor", () => {
    const f = forecastMonthSpend(
      [
        row({ at: at(1), imported: true, costUsd: 50 }),
        unpriced({ at: at(1) }),
        row({ at: at(3) }),
      ],
      NOW
    )
    expect(f.monthToDateUsd).toBe(1)
    expect(f.turns).toBe(2)
    expect(f.unpricedTurns).toBe(1)
  })

  it("has no run rate when the window holds only unpriced turns", () => {
    const f = forecastMonthSpend([unpriced({ at: at(3) }), unpriced({ at: at(1) })], NOW)
    expect(f.dailyRunRateUsd).toBeNull()
    expect(f.projectedMonthUsd).toBeNull()
  })

  it("asks for rows far enough back to cover both windows", () => {
    // The 20th: the month started earlier than the 7-day rate window.
    expect(forecastQueryStart(NOW)).toBe(new Date(2026, 4, 1).getTime())
    const early = new Date(2026, 4, 3, 12).getTime()
    expect(forecastQueryStart(early)).toBe(new Date(2026, 3, 27).getTime())
  })
})

describe("projectedLimitCrossing", () => {
  const forecast = forecastMonthSpend(
    Array.from({ length: 8 }, (_, i) => row({ at: at(i, 9), costUsd: 10 })),
    NOW
  )

  it("returns when the run rate reaches the limit within the month", () => {
    const crossing = projectedLimitCrossing(forecast, 200, NOW)
    expect(crossing).not.toBeNull()
    expect(crossing!).toBeGreaterThan(NOW)
    expect(crossing!).toBeLessThan(forecast.monthEnd)
  })

  it("is null once the limit is already behind, or never reached", () => {
    expect(projectedLimitCrossing(forecast, 50, NOW)).toBeNull()
    expect(projectedLimitCrossing(forecast, 1_000_000, NOW)).toBeNull()
    expect(projectedLimitCrossing(forecast, 0, NOW)).toBeNull()
  })
})

describe("estimateCacheSavings", () => {
  it("values each cache read at the base rate minus the cached rate", () => {
    const s = estimateCacheSavings(
      [row({ cacheReadTokens: 1_000_000, costUsd: 0.3 + 0.0105 })],
      priceFor
    )
    expect(s.savedUsd).toBeCloseTo(3 - 0.3)
    expect(s.pricedReadTokens).toBe(1_000_000)
    expect(s.savingsRate).toBeCloseTo(2.7 / (2.7 + 0.3105))
  })

  it("prefers the rates frozen on the row", () => {
    const s = estimateCacheSavings(
      [
        row({
          cacheReadTokens: 1_000_000,
          priceSnapshot: { promptPer1M: 10, cachedInputPer1M: 1, rateMultiplier: 2 },
        }),
      ],
      priceFor
    )
    expect(s.savedUsd).toBeCloseTo(18)
  })

  it("falls back to the default cache multiplier and skips unknown models", () => {
    const s = estimateCacheSavings(
      [
        row({ model: "plain", cacheReadTokens: 1_000_000 }),
        row({ model: "mystery", cacheReadTokens: 500 }),
      ],
      (_p, m) => (m === "plain" ? { promptPer1M: 2 } : null)
    )
    expect(s.savedUsd).toBeCloseTo(1.8)
    expect(s.unpricedReadTokens).toBe(500)
  })

  it("reports no rate when nothing was cached", () => {
    expect(estimateCacheSavings([row()], priceFor).savingsRate).toBeNull()
  })
})

describe("buildDailyStack", () => {
  it("keeps the top keys, folds the rest into other, and zero-fills the grid", () => {
    const rows = [
      row({ model: "a", costUsd: 5, at: at(0) }),
      row({ model: "b", costUsd: 3, at: at(1) }),
      row({ model: "c", costUsd: 1, at: at(1) }),
      row({ model: "d", costUsd: 0.5, at: at(2) }),
    ]
    const stack = buildDailyStack(rows, (r) => r.model ?? "", 3, NOW, { limit: 2 })
    expect(stack.keys).toEqual(["a", "b", OTHER_SERIES_KEY])
    expect(stack.days).toHaveLength(3)
    expect(stack.days[0].values).toEqual({ a: 0, b: 0, [OTHER_SERIES_KEY]: 0.5 })
    expect(stack.days[1].values).toEqual({ a: 0, b: 3, [OTHER_SERIES_KEY]: 1 })
    expect(stack.days[2].total).toBe(5)
  })

  it("drops rows outside the range and omits other when nothing overflows", () => {
    const stack = buildDailyStack([row({ model: "a", at: at(10) })], (r) => r.model ?? "", 7, NOW)
    expect(stack.keys).toEqual(["a"])
    expect(stack.days.every((d) => d.total === 0)).toBe(true)
  })
})

describe("buildActivityMatrix", () => {
  it("buckets by local weekday and hour and finds the peak", () => {
    const monday9 = new Date(2026, 4, 18, 9, 30).getTime()
    const m = buildActivityMatrix(
      [row({ at: monday9 }), row({ at: monday9 + 60_000, costUsd: 2 }), row({ at: NOW })],
      priceFor
    )
    expect(m.turns[1][9]).toBe(2)
    expect(m.costUsd[1][9]).toBe(3)
    expect(m.peak).toEqual({ weekday: 1, hour: 9, turns: 2 })
    expect(m.maxTurns).toBe(2)
  })

  it("has no peak without rows", () => {
    expect(buildActivityMatrix([]).peak).toBeNull()
  })
})

describe("summarizeTurnDistribution", () => {
  it("computes percentiles over priced turns and timed turns only", () => {
    const rows = [
      ...Array.from({ length: 9 }, () => row({ costUsd: 1, durationMs: 1000, outputTokens: 100 })),
      row({ costUsd: 10, durationMs: 0 }),
      unpriced({ durationMs: 2000, outputTokens: 400 }),
    ]
    const d = summarizeTurnDistribution(rows)
    expect(d.costPerTurn?.count).toBe(10)
    expect(d.costPerTurn?.p50).toBe(1)
    expect(d.costPerTurn?.max).toBe(10)
    expect(d.latencyMs?.count).toBe(10)
    expect(d.outputTokensPerSec?.max).toBe(200)
  })

  it("returns null distributions for empty input", () => {
    expect(summarizeTurnDistribution([])).toEqual({
      costPerTurn: null,
      latencyMs: null,
      outputTokensPerSec: null,
    })
  })
})

describe("detectSpendSpikes", () => {
  const days = (costs: number[]) =>
    costs.map((cost, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      cost,
      tokens: 0,
      requests: 1,
    }))

  it("flags days far above the median active day", () => {
    const spikes = detectSpendSpikes(days([1, 1, 1, 1, 1, 1, 9, 0, 4]))
    expect(spikes.map((s) => s.date)).toEqual(["2026-05-07", "2026-05-09"])
    expect(spikes[0].ratio).toBe(9)
    expect(spikes[0].medianUsd).toBe(1)
  })

  it("stays quiet with too few active days or cents-level noise", () => {
    expect(detectSpendSpikes(days([1, 1, 9]))).toEqual([])
    expect(detectSpendSpikes(days([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.1]))).toEqual([])
  })
})
