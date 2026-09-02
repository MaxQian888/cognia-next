// Row derivation for the Capacity Dock. The two rules that matter are the
// unpriced row (never a full gauge at zero) and the collapsed fallback (a
// pinned provider with no traffic must not empty the rail).

import { buildDockRows, collapsedRow, rowRatio } from "./rows"
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
    expect(rowRatio(glance({ knownCostUsd: 10 }), 4, "budget")).toBeCloseTo(0.4)
  })

  it("is null when the window has no known spend to divide by", () => {
    // Zero would draw an empty gauge, which reads as "this provider is free".
    expect(rowRatio(glance({ knownCostUsd: 0 }), 4, "budget")).toBeNull()
  })

  it("clamps a provider that somehow exceeds the total", () => {
    expect(rowRatio(glance({ knownCostUsd: 1 }), 5, "budget")).toBe(1)
  })

  it("reads plan headroom in quota mode", () => {
    const snap = glance({ quota: { worstUsedPct: 60, worstAccountKey: "a", resetAt: null } })
    expect(rowRatio(snap, 999, "quota")).toBeCloseTo(0.6)
  })

  it("is null in quota mode when no plan is configured", () => {
    expect(rowRatio(glance(), 1, "quota")).toBeNull()
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
})
