// Row derivation for the Capacity Dock. The two rules that matter are the
// unpriced row (never a full gauge at zero) and the collapsed fallback (a
// pinned provider with no traffic must not empty the rail).

import { buildDockQuotaRows, buildDockRows, collapsedRow, rowRatio, tightestWindow } from "./rows"
import type { GlanceQuotaSlice, GlanceQuotaSource, GlanceQuotaWindow } from "@/lib/glance/snapshot"
import { buildUsageGlance, type UsageGlanceSnapshotV1 } from "@/lib/usage/usage-glance"
import { UNKNOWN_COST } from "@/lib/usage/session-analytics"
import { MAX_DOCK_ROWS } from "./types"

const leader = (
  id: string,
  knownCostUsd: number,
  over: Partial<UsageGlanceSnapshotV1["topProviders"][number]> = {}
) => ({ id, knownCostUsd, tokens: 100, turns: 2, unpricedTurns: 0, ...over })

function glance(over: Partial<UsageGlanceSnapshotV1> = {}): UsageGlanceSnapshotV1 {
  return {
    ...buildUsageGlance({
      rows: [],
      query: { period: "today", scope: "cognia", metric: "spend" },
      now: 0,
    }),
    ...over,
  }
}

describe("rowRatio", () => {
  it("measures a provider against the window total in budget mode", () => {
    expect(rowRatio(glance({ knownCostUsd: 10 }), 4)).toBeCloseTo(0.4)
  })

  it("is null when the window has no known spend to divide by", () => {
    // Zero would draw an empty gauge, which reads as "this provider is free".
    expect(rowRatio(glance({ knownCostUsd: 0 }), 4)).toBeNull()
  })

  it("clamps a provider that somehow exceeds the total", () => {
    expect(rowRatio(glance({ knownCostUsd: 1 }), 5)).toBe(1)
  })
})

describe("buildDockRows", () => {
  it("defaults to the busiest providers in cost order", () => {
    const snap = glance({
      knownCostUsd: 10,
      topProviders: [leader("dear", 7), leader("cheap", 3)],
    })
    expect(buildDockRows({ snapshot: snap }).map((r) => r.providerId)).toEqual(["dear", "cheap"])
  })

  it("honours the user's pinned order", () => {
    const snap = glance({
      knownCostUsd: 10,
      topProviders: [leader("dear", 7), leader("cheap", 3)],
    })
    const rows = buildDockRows({ snapshot: snap, providerIds: ["cheap", "dear"] })
    expect(rows.map((r) => r.providerId)).toEqual(["cheap", "dear"])
  })

  it("drops a pinned provider with no traffic rather than drawing a blank row", () => {
    const snap = glance({ knownCostUsd: 10, topProviders: [leader("dear", 10)] })
    const rows = buildDockRows({ snapshot: snap, providerIds: ["ghost", "dear"] })
    expect(rows.map((r) => r.providerId)).toEqual(["dear"])
  })

  it("caps the rail at the maximum visible rows", () => {
    const snap = glance({
      knownCostUsd: 10,
      topProviders: Array.from({ length: 9 }, (_, i) => leader(`p${i}`, 1)),
    })
    expect(buildDockRows({ snapshot: snap })).toHaveLength(MAX_DOCK_ROWS)
  })

  it("renders an entirely unpriced provider as a dash with no gauge", () => {
    const snap = glance({
      knownCostUsd: 0,
      topProviders: [leader("mystery", 0, { turns: 3, unpricedTurns: 3 })],
    })
    const [row] = buildDockRows({ snapshot: snap })
    expect(row.label).toBe(UNKNOWN_COST)
    expect(row.ratio).toBeNull()
    expect(row.severity).toBe("unknown")
  })

  it("marks a partially priced provider as a lower bound", () => {
    const snap = glance({
      knownCostUsd: 4,
      topProviders: [leader("mixed", 4, { turns: 5, unpricedTurns: 2 })],
    })
    expect(buildDockRows({ snapshot: snap })[0].label.startsWith("≥")).toBe(true)
  })

  it("escalates severity with the ratio", () => {
    const snap = glance({
      knownCostUsd: 10,
      topProviders: [leader("hot", 10), leader("warm", 8.5), leader("cool", 1)],
    })
    const byId = new Map(buildDockRows({ snapshot: snap }).map((r) => [r.providerId, r.severity]))
    expect(byId.get("hot")).toBe("exceeded")
    expect(byId.get("warm")).toBe("warn")
    expect(byId.get("cool")).toBe("ok")
  })

  it("returns nothing for an empty window", () => {
    expect(buildDockRows({ snapshot: glance() })).toEqual([])
  })
})

describe("collapsedRow", () => {
  const rows = buildDockRows({
    snapshot: glance({ knownCostUsd: 10, topProviders: [leader("dear", 7), leader("cheap", 3)] }),
  })

  it("shows the pinned provider when it is in the window", () => {
    expect(collapsedRow(rows, "cheap")?.providerId).toBe("cheap")
  })

  it("falls back to the busiest when the pin has no traffic today", () => {
    // Otherwise a pinned provider the user simply has not used collapses the
    // whole rail to nothing, which reads as "the dock is broken".
    expect(collapsedRow(rows, "ghost")?.providerId).toBe("dear")
  })

  it("shows the busiest when nothing is pinned", () => {
    expect(collapsedRow(rows, null)?.providerId).toBe("dear")
  })

  it("is null when there is nothing at all", () => {
    expect(collapsedRow([], "x")).toBeNull()
  })

  it("matches a quota row by source key, then by provider", () => {
    const quota = buildDockQuotaRows({
      slice: quotaSlice([
        source("anthropic:a", "anthropic", [win("five-hour", 90)]),
        source("codex:b", "codex", [win("weekly", 30)]),
      ]),
    })
    expect(collapsedRow(quota, "codex:b")?.key).toBe("codex:b")
    expect(collapsedRow(quota, "codex")?.key).toBe("codex:b")
    expect(collapsedRow(quota, "ghost")?.key).toBe("anthropic:a")
  })
})

function win(id: string, usedPct: number | null, over: Partial<GlanceQuotaWindow> = {}) {
  return {
    id,
    labelKey: null,
    label: id,
    kind: "window",
    usedPct,
    resetAt: null,
    remaining: null,
    unit: null,
    currency: null,
    severity: usedPct === null ? "unknown" : usedPct >= 80 ? "warn" : "ok",
    ...over,
  } as GlanceQuotaWindow
}

function source(
  key: string,
  provider: string,
  windows: GlanceQuotaWindow[],
  over: Partial<GlanceQuotaSource> = {}
): GlanceQuotaSource {
  return {
    key,
    provider,
    accountId: key.split(":")[1] ?? null,
    accountLabel: `${provider} account`,
    state: "ok",
    windows,
    fetchedAt: 1,
    error: null,
    ...over,
  }
}

function quotaSlice(sources: GlanceQuotaSource[]): GlanceQuotaSlice {
  return { updatedAt: 1, refreshing: false, sources }
}

describe("tightestWindow", () => {
  it("picks the window with the highest used share", () => {
    expect(tightestWindow([win("a", 20), win("b", 70), win("c", 40)])?.id).toBe("b")
  })

  it("ignores windows with no reading", () => {
    expect(tightestWindow([win("a", null), win("b", 10)])?.id).toBe("b")
    expect(tightestWindow([win("a", null)])).toBeNull()
    expect(tightestWindow([])).toBeNull()
  })
})

describe("buildDockQuotaRows", () => {
  it("is empty without a slice", () => {
    expect(buildDockQuotaRows({ slice: null })).toEqual([])
  })

  it("draws one row per source from its tightest window, used share as the label", () => {
    const [row] = buildDockQuotaRows({
      slice: quotaSlice([
        source("anthropic:a", "anthropic", [
          win("five-hour", 42.4, { resetAt: 5000 }),
          win("weekly", 81.6, { resetAt: 9000 }),
        ]),
      ]),
    })
    expect(row).toMatchObject({
      key: "anthropic:a",
      providerId: "anthropic",
      accountLabel: "anthropic account",
      label: "82%",
      severity: "warn",
      quotaState: "ok",
      resetAt: 9000,
    })
    expect(row.ratio).toBeCloseTo(0.816)
  })

  it("orders the tightest source first and a source with no reading last", () => {
    const rows = buildDockQuotaRows({
      slice: quotaSlice([
        source("x:1", "x", [win("w", null)], { state: "refreshing", fetchedAt: null }),
        source("y:1", "y", [win("w", 10)]),
        source("z:1", "z", [win("w", 95)]),
      ]),
    })
    expect(rows.map((r) => r.key)).toEqual(["z:1", "y:1", "x:1"])
    expect(rows[2]).toMatchObject({ ratio: null, label: UNKNOWN_COST, severity: "unknown" })
  })

  it("keeps a stale or failed reading's ratio but drops its colour", () => {
    const rows = buildDockQuotaRows({
      slice: quotaSlice([
        source("a:1", "a", [win("w", 96, { severity: "crit" })], { state: "stale" }),
        source("b:1", "b", [win("w", 50)], { state: "error", error: "boom" }),
      ]),
    })
    expect(rows[0]).toMatchObject({ key: "a:1", severity: "unknown", quotaState: "stale" })
    expect(rows[0].ratio).toBeCloseTo(0.96)
    expect(rows[1]).toMatchObject({ key: "b:1", severity: "unknown", quotaState: "error" })
  })

  it("keeps the window's own severity for a current reading", () => {
    const [row] = buildDockQuotaRows({
      slice: quotaSlice([
        source("a:1", "a", [win("w", 100, { severity: "exceeded" })], { state: "exhausted" }),
      ]),
    })
    expect(row).toMatchObject({ severity: "exceeded", ratio: 1 })
  })

  it("leaves out sources that are not queried", () => {
    const rows = buildDockQuotaRows({
      slice: quotaSlice([
        source("a:1", "a", [], { state: "disabled", fetchedAt: null }),
        source("discovered:codex", "codex", [], { state: "discovered", accountId: null }),
        source("b:1", "b", [win("w", 5)]),
      ]),
    })
    expect(rows.map((r) => r.key)).toEqual(["b:1"])
  })

  it("caps the rail at the maximum visible rows", () => {
    const sources = Array.from({ length: 8 }, (_, i) => source(`p:${i}`, "p", [win("w", i)]))
    expect(buildDockQuotaRows({ slice: quotaSlice(sources) })).toHaveLength(MAX_DOCK_ROWS)
  })
})
