import { localDay } from "@/lib/usage/session-analytics"
import {
  USAGE_GLANCE_VERSION,
  type UsageGlanceBucket,
  type UsageGlanceLeader,
  type UsageGlanceSnapshotV1,
} from "@/lib/usage/usage-glance"

import { buildUsageSlice, lastLocalDays } from "./build-usage"

const DAY_MS = 86_400_000

function dayDiffs(keys: string[]): number[] {
  const ms = keys.map((key) => {
    const [y, m, d] = key.split("-").map(Number)
    return Date.UTC(y, m - 1, d)
  })
  return ms.slice(1).map((value, i) => (value - ms[i]) / DAY_MS)
}

describe("lastLocalDays", () => {
  it("returns `count` keys ending today, oldest first", () => {
    const now = new Date(2026, 5, 15, 9, 30).getTime()
    expect(lastLocalDays(now, 7)).toEqual([
      "2026-06-09",
      "2026-06-10",
      "2026-06-11",
      "2026-06-12",
      "2026-06-13",
      "2026-06-14",
      "2026-06-15",
    ])
  })

  it("returns just today for a count of 1 and nothing for 0", () => {
    const now = new Date(2026, 5, 15, 9, 30).getTime()
    expect(lastLocalDays(now, 1)).toEqual(["2026-06-15"])
    expect(lastLocalDays(now, 0)).toEqual([])
  })

  it("is not affected by the time of day", () => {
    const early = lastLocalDays(new Date(2026, 5, 15, 0, 0, 1).getTime(), 3)
    const late = lastLocalDays(new Date(2026, 5, 15, 23, 59, 59).getTime(), 3)
    expect(early).toEqual(["2026-06-13", "2026-06-14", "2026-06-15"])
    expect(late).toEqual(early)
  })

  it("crosses a month boundary", () => {
    const now = new Date(2026, 2, 3, 12).getTime()
    expect(lastLocalDays(now, 7)).toEqual([
      "2026-02-25",
      "2026-02-26",
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
    ])
  })

  it("crosses a year boundary", () => {
    const now = new Date(2026, 0, 2, 12).getTime()
    const keys = lastLocalDays(now, 4)
    expect(keys).toEqual(["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"])
  })

  it("includes a leap day", () => {
    const now = new Date(2028, 2, 2, 12).getTime()
    expect(lastLocalDays(now, 4)).toEqual(["2028-02-28", "2028-02-29", "2028-03-01", "2028-03-02"])
  })

  it("yields consecutive calendar days with no duplicates across the March DST change", () => {
    // 2026-03-08 is the US spring-forward day (a 23-hour day). Millisecond
    // subtraction would repeat or skip a key around it in those zones.
    const now = new Date(2026, 2, 8, 12).getTime()
    const keys = lastLocalDays(now, 14)
    expect(keys).toHaveLength(14)
    expect(new Set(keys).size).toBe(14)
    expect(keys[keys.length - 1]).toBe("2026-03-08")
    expect(keys[0]).toBe("2026-02-23")
    expect(dayDiffs(keys).every((d) => d === 1)).toBe(true)
  })

  it("yields consecutive days across the November fall-back change and a day after DST", () => {
    for (const now of [
      new Date(2026, 10, 1, 12).getTime(),
      new Date(2026, 10, 2, 0, 30).getTime(),
      new Date(2026, 2, 9, 0, 30).getTime(),
    ]) {
      const keys = lastLocalDays(now, 10)
      expect(new Set(keys).size).toBe(10)
      expect(dayDiffs(keys).every((d) => d === 1)).toBe(true)
      expect(keys[9]).toBe(localDay(now))
    }
  })

  it("covers a long window with no gaps", () => {
    const keys = lastLocalDays(new Date(2026, 2, 8, 12).getTime(), 371)
    expect(new Set(keys).size).toBe(371)
    expect(dayDiffs(keys).every((d) => d === 1)).toBe(true)
  })
})

function bucket(day: string, tokens: number, knownCostUsd = 0, turns = 1): UsageGlanceBucket {
  return { day, tokens, knownCostUsd, turns }
}

function leader(id: string, tokens: number, knownCostUsd = 0): UsageGlanceLeader {
  return { id, tokens, knownCostUsd, turns: 1, unpricedTurns: 0 }
}

function glance(patch: Partial<UsageGlanceSnapshotV1> = {}): UsageGlanceSnapshotV1 {
  return {
    version: USAGE_GLANCE_VERSION,
    query: { period: "30d", scope: "cognia", metric: "tokens" },
    generatedAt: 4242,
    freshness: "fresh",
    coverageFromMs: 0,
    coverageToMs: 0,
    knownCostUsd: 0,
    unpricedTurns: 0,
    turns: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    billableTokens: 0,
    daily: [],
    topProviders: [],
    topModels: [],
    bySource: [],
    quota: null,
    budget: null,
    ...patch,
  }
}

const NOW = new Date(2026, 2, 8, 12).getTime()
const input = { scope: "cognia", showSpend: false, workspaceFiltered: false, now: NOW } as const

describe("buildUsageSlice", () => {
  it("returns zeros for a null glance", () => {
    const slice = buildUsageSlice({ ...input, glance: null })
    expect(slice).toMatchObject({
      updatedAt: NOW,
      scope: "cognia",
      showSpend: false,
      workspaceFiltered: false,
      freshness: "fresh",
      today: { tokens: 0, knownCostUsd: 0, turns: 0 },
      week: { tokens: 0, knownCostUsd: 0, turns: 0 },
      month: { tokens: 0, knownCostUsd: 0, turns: 0 },
      unpricedTurns: 0,
      topModel: null,
      providers: [],
      budget: null,
    })
    expect(slice.sparkline).toHaveLength(7)
    expect(
      slice.sparkline.every((d) => d.tokens === 0 && d.knownCostUsd === 0 && d.turns === 0)
    ).toBe(true)
    expect(slice.sparkline[6].day).toBe("2026-03-08")
  })

  it("echoes scope, showSpend and workspaceFiltered", () => {
    const slice = buildUsageSlice({
      glance: null,
      scope: "all-tools",
      showSpend: true,
      workspaceFiltered: true,
      now: NOW,
    })
    expect(slice).toMatchObject({ scope: "all-tools", showSpend: true, workspaceFiltered: true })
  })

  it("takes updatedAt and freshness from the glance", () => {
    const slice = buildUsageSlice({ ...input, glance: glance({ freshness: "partial" }) })
    expect(slice.updatedAt).toBe(4242)
    expect(slice.freshness).toBe("partial")
  })

  it("derives today and the week from the daily buckets, zero-filled", () => {
    const slice = buildUsageSlice({
      ...input,
      glance: glance({
        daily: [
          bucket("2026-03-08", 100, 1.5, 4),
          bucket("2026-03-06", 50, 0.5, 2),
          bucket("2026-03-02", 25, 0.25, 1),
          // Outside the 7-day window: counted in month totals only.
          bucket("2026-03-01", 9_999, 9, 9),
        ],
      }),
    })
    expect(slice.today).toEqual({ tokens: 100, knownCostUsd: 1.5, turns: 4 })
    expect(slice.week).toEqual({ tokens: 175, knownCostUsd: 2.25, turns: 7 })
    expect(slice.sparkline.map((d) => d.day)).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
    ])
    expect(slice.sparkline.map((d) => d.tokens)).toEqual([25, 0, 0, 0, 50, 0, 100])
  })

  it("reports zero today when only earlier days have data", () => {
    const slice = buildUsageSlice({
      ...input,
      glance: glance({ daily: [bucket("2026-03-07", 80)] }),
    })
    expect(slice.today).toEqual({ tokens: 0, knownCostUsd: 0, turns: 0 })
    expect(slice.week.tokens).toBe(80)
  })

  it("takes the month figure from the snapshot totals (billable tokens), not the buckets", () => {
    const slice = buildUsageSlice({
      ...input,
      glance: glance({
        billableTokens: 12_345,
        knownCostUsd: 7.5,
        turns: 33,
        unpricedTurns: 2,
        daily: [bucket("2026-03-08", 1)],
      }),
    })
    expect(slice.month).toEqual({ tokens: 12_345, knownCostUsd: 7.5, turns: 33 })
    expect(slice.unpricedTurns).toBe(2)
  })

  it("exposes the top model", () => {
    const slice = buildUsageSlice({
      ...input,
      glance: glance({ topModels: [leader("claude-x", 500, 2.5), leader("other", 10)] }),
    })
    expect(slice.topModel).toEqual({ id: "claude-x", tokens: 500, knownCostUsd: 2.5 })
  })

  it("computes provider shares over all providers and caps the list at four", () => {
    const slice = buildUsageSlice({
      ...input,
      glance: glance({
        topProviders: [
          leader("a", 50, 1),
          leader("b", 25),
          leader("c", 15),
          leader("d", 5),
          leader("e", 5),
        ],
      }),
    })
    expect(slice.providers.map((p) => p.id)).toEqual(["a", "b", "c", "d"])
    expect(slice.providers.map((p) => p.share)).toEqual([0.5, 0.25, 0.15, 0.05])
    expect(slice.providers[0]).toEqual({ id: "a", tokens: 50, knownCostUsd: 1, share: 0.5 })
  })

  it("gives shares of 0 when providers carry no tokens", () => {
    const slice = buildUsageSlice({ ...input, glance: glance({ topProviders: [leader("a", 0)] }) })
    expect(slice.providers[0].share).toBe(0)
  })

  describe("budget", () => {
    it("is null when there is no budget or its ratio is null", () => {
      expect(buildUsageSlice({ ...input, glance: glance() }).budget).toBeNull()
      expect(
        buildUsageSlice({
          ...input,
          glance: glance({ budget: { ratio: null, target: null, period: null, blocked: false } }),
        }).budget
      ).toBeNull()
    })

    it("carries ratio, period and blocked without the target", () => {
      const slice = buildUsageSlice({
        ...input,
        glance: glance({
          budget: { ratio: 0.8, target: "global", period: "month", blocked: true },
        }),
      })
      expect(slice.budget).toEqual({ ratio: 0.8, period: "month", blocked: true })
    })

    it("keeps a zero ratio (a budget is in force)", () => {
      const slice = buildUsageSlice({
        ...input,
        glance: glance({ budget: { ratio: 0, target: null, period: "day", blocked: false } }),
      })
      expect(slice.budget).toEqual({ ratio: 0, period: "day", blocked: false })
    })
  })
})
