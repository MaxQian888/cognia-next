import type { SessionUsageRow } from "@/lib/db/session-usage"
import type { SessionUsageSummary } from "./session-analytics"
import {
  buildTurnTimeline,
  contextGrowth,
  costConcentration,
  detectContextDrops,
  rankSessionCost,
  topCostlyTurns,
} from "./session-cost-profile"

function row(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: "m",
    sessionId: "s1",
    at: 1_000,
    model: "m1",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 1,
    costSource: "sdk",
    costKnown: true,
    durationMs: 500,
    ...overrides,
  }
}

function summary(sessionId: string, costUsd: number, unpricedTurns = 0): SessionUsageSummary {
  return {
    sessionId,
    turns: 2,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd,
    unpricedTurns,
  }
}

describe("buildTurnTimeline", () => {
  it("orders turns by time and keeps a running total of known cost", () => {
    const points = buildTurnTimeline([
      row({ messageId: "b", at: 2_000, costUsd: 2 }),
      row({ messageId: "a", at: 1_000, costUsd: 1, surface: "subagent" }),
      row({ messageId: "c", at: 3_000, costUsd: 0, costSource: "unknown", costKnown: false }),
    ])
    expect(points.map((p) => [p.index, p.messageId, p.cumulativeCostUsd])).toEqual([
      [1, "a", 1],
      [2, "b", 3],
      [3, "c", 3],
    ])
    expect(points[0].surface).toBe("subagent")
    expect(points[1].surface).toBe("chat")
    expect(points[2].costKnown).toBe(false)
  })

  it("prefers the reported context size and otherwise sums the prompt tiers", () => {
    const [reported, derived] = buildTurnTimeline([
      row({ messageId: "a", at: 1, contextInputTokens: 9_000 }),
      row({ messageId: "b", at: 2, inputTokens: 10, cacheReadTokens: 20, cacheCreationTokens: 30 }),
    ])
    expect(reported.contextTokens).toBe(9_000)
    expect(derived.contextTokens).toBe(60)
  })
})

describe("topCostlyTurns / costConcentration / contextGrowth", () => {
  const points = buildTurnTimeline([
    row({ messageId: "a", at: 1, costUsd: 1, inputTokens: 100 }),
    row({ messageId: "b", at: 2, costUsd: 6, inputTokens: 400 }),
    row({ messageId: "c", at: 3, costUsd: 3, inputTokens: 500 }),
    row({ messageId: "d", at: 4, costUsd: 0, costSource: "unknown", costKnown: false }),
  ])

  it("ranks priced turns costliest first and drops unpriced ones", () => {
    expect(topCostlyTurns(points, 2).map((p) => p.messageId)).toEqual(["b", "c"])
    expect(topCostlyTurns(points).map((p) => p.messageId)).not.toContain("d")
  })

  it("measures how much of the bill one turn carries", () => {
    expect(costConcentration(points)).toBeCloseTo(0.6)
    expect(costConcentration(points.slice(0, 1))).toBeNull()
  })

  it("compares the last turn's context with the first", () => {
    expect(contextGrowth(points.slice(0, 3))).toBe(5)
    expect(contextGrowth(points.slice(0, 1))).toBeNull()
  })
})

describe("rankSessionCost", () => {
  const peers = [1, 2, 3, 4, 5, 6].map((c, i) => summary(`p${i}`, c))

  it("places the session among fully priced peers", () => {
    const rank = rankSessionCost(summary("me", 4.5), [...peers, summary("me", 4.5)])
    expect(rank).toEqual({ percentile: 67, peers: 6, medianUsd: 3.5 })
  })

  it("refuses to rank a lower bound or against too few peers", () => {
    expect(rankSessionCost(summary("me", 4, 1), peers)).toBeNull()
    expect(rankSessionCost(summary("me", 4), peers.slice(0, 4))).toBeNull()
  })

  it("leaves unpriced peers out of the comparison", () => {
    const rank = rankSessionCost(summary("me", 10), [...peers, summary("x", 0, 2)])
    expect(rank?.peers).toBe(6)
    expect(rank?.percentile).toBe(100)
  })
})

describe("detectContextDrops", () => {
  it("marks turns whose context fell sharply from the previous one", () => {
    const points = buildTurnTimeline([
      row({ messageId: "a", at: 1, contextInputTokens: 100_000 }),
      row({ messageId: "b", at: 2, contextInputTokens: 120_000 }),
      row({ messageId: "c", at: 3, contextInputTokens: 30_000 }),
      row({ messageId: "d", at: 4, contextInputTokens: 25_000 }),
    ])
    expect(detectContextDrops(points).map((p) => p.messageId)).toEqual(["c"])
    expect(detectContextDrops(points, 0.1).map((p) => p.messageId)).toEqual(["c", "d"])
  })
})
