/**
 * @jest-environment node
 */
import { analyzeSession, HIGH_CONTEXT_THRESHOLD, sessionInsights } from "./usage-analysis"

describe("analyzeSession", () => {
  it("returns zeros for an empty session", () => {
    const a = analyzeSession()
    expect(a).toMatchObject({
      turns: 0,
      highContextTurns: 0,
      highContextPct: 0,
      dispatchCalls: 0,
      totalToolCalls: 0,
      topTools: [],
    })
    expect(a.highContextThreshold).toBe(HIGH_CONTEXT_THRESHOLD)
  })

  it("computes the >150k context share of turns", () => {
    const a = analyzeSession({
      usageHistory: [10_000, 160_000, 200_000, 50_000],
    })
    expect(a.turns).toBe(4)
    expect(a.highContextTurns).toBe(2)
    expect(a.highContextPct).toBe(50)
  })

  it("honors a custom threshold", () => {
    const a = analyzeSession({ usageHistory: [40_000, 60_000], highContextThreshold: 50_000 })
    expect(a.highContextTurns).toBe(1)
    expect(a.highContextPct).toBe(50)
  })

  it("surfaces subagent dispatch calls and tool shares", () => {
    const a = analyzeSession({
      toolStats: {
        bash: { calls: 6, errors: 0 },
        dispatch_agent: { calls: 2, errors: 0 },
        read: { calls: 2, errors: 1 },
      },
    })
    expect(a.totalToolCalls).toBe(10)
    expect(a.dispatchCalls).toBe(2)
    expect(a.topTools[0]).toEqual({ name: "bash", calls: 6, pct: 60 })
    expect(a.topTools.map((t) => t.name)).toEqual(["bash", "dispatch_agent", "read"])
  })

  it("caps topTools and drops zero-call entries", () => {
    const stats: Record<string, { calls: number; errors: number }> = {}
    for (let i = 0; i < 8; i++) stats[`t${i}`] = { calls: i, errors: 0 }
    const a = analyzeSession({ toolStats: stats, topToolLimit: 3 })
    // t0 has 0 calls → dropped; top 3 by calls are t7,t6,t5.
    expect(a.topTools.map((t) => t.name)).toEqual(["t7", "t6", "t5"])
  })
})

describe("sessionInsights", () => {
  it("returns no insights for a clean session", () => {
    const a = analyzeSession({ usageHistory: [1000], toolStats: { read: { calls: 2, errors: 0 } } })
    expect(sessionInsights(a)).toEqual([])
  })

  it("surfaces a high-context insight with a humanized threshold and advice", () => {
    const a = analyzeSession({ usageHistory: [200_000, 10_000] })
    const insights = sessionInsights(a)
    const ctx = insights.find((i) => i.id === "high-context")
    expect(ctx?.headline).toBe("50% of turns ran at >150k context")
    expect(ctx?.advice).toMatch(/\/compact/)
  })

  it("surfaces a subagent-share insight from dispatch tool calls", () => {
    const a = analyzeSession({
      toolStats: {
        bash: { calls: 6, errors: 0 },
        dispatch_agent: { calls: 4, errors: 0 },
      },
    })
    const sub = sessionInsights(a).find((i) => i.id === "subagent-heavy")
    expect(sub?.headline).toBe("40% of tool calls dispatched a subagent")
    expect(sub?.advice).toMatch(/cheaper model/)
  })

  it("honors a custom threshold in the high-context headline", () => {
    const a = analyzeSession({ usageHistory: [60_000], highContextThreshold: 50_000 })
    const ctx = sessionInsights(a).find((i) => i.id === "high-context")
    expect(ctx?.headline).toBe("100% of turns ran at >50k context")
  })
})
