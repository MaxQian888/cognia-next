// The projection every ambient surface reads. The tests that matter are the
// ones about honesty: unknown cost never becomes zero, external spend never
// enters the Cognia scope, and an empty window says stale rather than $0.00.

import type { SessionUsageRow } from "@/lib/db/session-usage"
import {
  buildUsageGlance,
  emptyUsageGlance,
  periodStart,
  rowInScope,
  USAGE_GLANCE_METRICS,
  USAGE_GLANCE_PERIODS,
  USAGE_GLANCE_SCOPES,
  USAGE_GLANCE_VERSION,
  type UsageGlanceQuery,
} from "./usage-glance"

const NOON = new Date(2026, 5, 5, 12, 0, 0).getTime()
const DAY_MS = 86_400_000

const flatPricing = () => ({ promptPer1M: 1000, completionPer1M: 2000 })

const query: UsageGlanceQuery = { period: "today", scope: "cognia", metric: "spend" }

function row(over: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: "m1",
    sessionId: "s1",
    at: NOON,
    model: "test-model",
    providerId: "acme",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 2,
    durationMs: 0,
    costSource: "sdk",
    costKnown: true,
    ...over,
  }
}

describe("periodStart", () => {
  it("starts today at local midnight", () => {
    expect(periodStart("today", NOON)).toBe(new Date(2026, 5, 5).getTime())
  })

  it("starts the calendar month on the first", () => {
    expect(periodStart("month", NOON)).toBe(new Date(2026, 5, 1).getTime())
  })

  it("covers seven local days inclusive of today", () => {
    expect(periodStart("7d", NOON)).toBe(new Date(2026, 4, 30).getTime())
  })

  it("has a start for every declared period", () => {
    for (const period of USAGE_GLANCE_PERIODS) {
      expect(periodStart(period, NOON)).toBeLessThanOrEqual(NOON)
    }
  })
})

describe("rowInScope", () => {
  it("keeps external spend out of the Cognia scope", () => {
    expect(rowInScope(row({ sourceId: "codex", imported: true }), "cognia")).toBe(false)
    expect(rowInScope(row({ imported: true }), "cognia")).toBe(false)
  })

  it("includes everything in the all-tools scope", () => {
    expect(rowInScope(row({ sourceId: "codex", imported: true }), "all-tools")).toBe(true)
    expect(rowInScope(row(), "all-tools")).toBe(true)
  })

  it("declares two scopes and no more", () => {
    expect(USAGE_GLANCE_SCOPES).toEqual(["cognia", "all-tools"])
  })
})

describe("buildUsageGlance", () => {
  it("sums known cost and counts turns and sessions", () => {
    const snap = buildUsageGlance({
      rows: [row(), row({ messageId: "m2", sessionId: "s2" })],
      query,
      now: NOON,
      resolve: flatPricing,
    })
    expect(snap.version).toBe(USAGE_GLANCE_VERSION)
    expect(snap.knownCostUsd).toBeCloseTo(4, 6)
    expect(snap.turns).toBe(2)
    expect(snap.sessions).toBe(2)
    expect(snap.billableTokens).toBe(3000)
  })

  it("counts an unpriceable turn instead of folding a zero into the total", () => {
    const snap = buildUsageGlance({
      rows: [row(), row({ messageId: "m2", costSource: "unknown", costKnown: false, costUsd: 0 })],
      query,
      now: NOON,
      resolve: flatPricing,
    })
    expect(snap.knownCostUsd).toBeCloseTo(2, 6)
    expect(snap.unpricedTurns).toBe(1)
    expect(snap.turns).toBe(2)
  })

  it("excludes rows outside the period", () => {
    const snap = buildUsageGlance({
      rows: [row(), row({ messageId: "old", at: NOON - 3 * DAY_MS })],
      query,
      now: NOON,
      resolve: flatPricing,
    })
    expect(snap.turns).toBe(1)
  })

  it("excludes rows dated far in the future rather than trusting a bad clock", () => {
    const snap = buildUsageGlance({
      rows: [row({ at: NOON + DAY_MS })],
      query,
      now: NOON,
      resolve: flatPricing,
    })
    expect(snap.turns).toBe(0)
  })

  it("admits a turn committed since the caller's clock last ticked", () => {
    // The ambient surfaces read a shared ticker, not a fresh clock, so a turn
    // written seconds ago is legitimately ahead of `now`. Dropping it would
    // make the menu bar lag the write it exists to reflect.
    const snap = buildUsageGlance({
      rows: [row({ at: NOON + 30_000 })],
      query,
      now: NOON,
      resolve: flatPricing,
    })
    expect(snap.turns).toBe(1)
  })

  it("keeps external spend out of the Cognia scope and folds it into all-tools", () => {
    const rows = [row(), row({ messageId: "x", sourceId: "codex", imported: true, costUsd: 10 })]
    const cognia = buildUsageGlance({ rows, query, now: NOON, resolve: flatPricing })
    const all = buildUsageGlance({
      rows,
      query: { ...query, scope: "all-tools" },
      now: NOON,
      resolve: flatPricing,
    })
    expect(cognia.knownCostUsd).toBeCloseTo(2, 6)
    expect(cognia.bySource).toEqual([])
    expect(all.knownCostUsd).toBeCloseTo(12, 6)
    expect(all.bySource.map((s) => s.id)).toEqual(["codex"])
  })

  it("ranks providers and models by known cost", () => {
    const snap = buildUsageGlance({
      rows: [
        row({ providerId: "cheap", model: "small", costUsd: 1 }),
        row({ messageId: "m2", providerId: "dear", model: "big", costUsd: 9 }),
      ],
      query,
      now: NOON,
      resolve: flatPricing,
    })
    expect(snap.topProviders.map((p) => p.id)).toEqual(["dear", "cheap"])
    expect(snap.topModels.map((m) => m.id)).toEqual(["big", "small"])
  })

  it("caps the leaders lists", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row({ messageId: `m${i}`, providerId: `p${i}`, costUsd: i + 1 })
    )
    const snap = buildUsageGlance({ rows, query, now: NOON, topN: 3, resolve: flatPricing })
    expect(snap.topProviders).toHaveLength(3)
  })

  it("buckets by local day, oldest first", () => {
    const snap = buildUsageGlance({
      rows: [row({ at: NOON - DAY_MS }), row({ messageId: "m2", at: NOON })],
      query: { ...query, period: "7d" },
      now: NOON,
      resolve: flatPricing,
    })
    expect(snap.daily.map((b) => b.day)).toEqual(["2026-06-04", "2026-06-05"])
  })

  it("filters to one provider when a surface is pinned", () => {
    const snap = buildUsageGlance({
      rows: [row(), row({ messageId: "m2", providerId: "other" })],
      query: { ...query, providerId: "acme" },
      now: NOON,
      resolve: flatPricing,
    })
    expect(snap.turns).toBe(1)
  })

  it("filters to one external source", () => {
    const snap = buildUsageGlance({
      rows: [
        row({ messageId: "a", sourceId: "codex", imported: true }),
        row({ messageId: "b", sourceId: "cursor", imported: true }),
      ],
      query: { ...query, scope: "all-tools", sourceId: "codex" },
      now: NOON,
      resolve: flatPricing,
    })
    expect(snap.turns).toBe(1)
  })

  it("reports coverage as the window when it saw nothing", () => {
    const snap = buildUsageGlance({ rows: [], query, now: NOON })
    expect(snap.coverageFromMs).toBe(periodStart("today", NOON))
    expect(snap.coverageToMs).toBe(snap.coverageFromMs)
  })

  it("carries the quota and budget folds through untouched", () => {
    const snap = buildUsageGlance({
      rows: [],
      query,
      now: NOON,
      quota: { worstUsedPct: 42, worstAccountKey: "anthropic:a", resetAt: NOON },
      budget: { ratio: 0.5, target: "global", period: "day", blocked: false },
    })
    expect(snap.quota?.worstUsedPct).toBe(42)
    expect(snap.budget?.ratio).toBe(0.5)
  })

  it("carries no session content whatsoever", () => {
    const snap = buildUsageGlance({ rows: [row()], query, now: NOON, resolve: flatPricing })
    // The OS-facing projection is pushed into a Rust process and painted into
    // a menu bar. Everything on it must be a number, an id, or an enum.
    const serialized = JSON.stringify(snap)
    expect(serialized).not.toContain("s1")
    expect(snap.topProviders.every((p) => typeof p.id === "string")).toBe(true)
  })

  it("declares every metric the surfaces can lead with", () => {
    expect(USAGE_GLANCE_METRICS).toEqual(["spend", "tokens", "quota", "budget"])
  })
})

describe("emptyUsageGlance", () => {
  it("is stale rather than a confident zero", () => {
    const snap = emptyUsageGlance(query, NOON)
    expect(snap.freshness).toBe("stale")
    expect(snap.turns).toBe(0)
    expect(snap.knownCostUsd).toBe(0)
  })
})
