import type { Goal, GoalStatus } from "@/types/goal"
import { computeGoalAnalytics, DEFAULT_ANALYTICS_WINDOW_DAYS } from "./analytics"

const DAY_MS = 24 * 60 * 60_000
// Fixed "now" — 2026-05-31T12:00 local. All buckets derive from this.
const NOW = new Date(2026, 4, 31, 12, 0, 0).getTime()

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: crypto.randomUUID(),
    sessionId: "ses",
    rawObjective: "obj",
    safeObjective: "obj",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 0,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
    generationId: "gen",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe("computeGoalAnalytics — counters", () => {
  it("returns zeroed aggregates for an empty list with a full-width timeline", () => {
    const a = computeGoalAnalytics([], { now: NOW })
    expect(a.total).toBe(0)
    expect(a.completionRate).toBe(0)
    expect(a.avgTurns).toBe(0)
    expect(a.avgTokens).toBe(0)
    expect(a.judgeFailureRate).toBe(0)
    expect(a.statusDistribution).toEqual([])
    expect(a.timeline).toHaveLength(DEFAULT_ANALYTICS_WINDOW_DAYS)
    expect(a.timeline.every((b) => b.created === 0 && b.tokens === 0)).toBe(true)
  })

  it("counts statuses and computes completion rate over terminal goals", () => {
    const a = computeGoalAnalytics(
      [
        goal({ status: "active" }),
        goal({ status: "paused" }),
        goal({ status: "completed" }),
        goal({ status: "completed" }),
        goal({ status: "stopped" }),
      ],
      { now: NOW }
    )
    expect(a.total).toBe(5)
    expect(a.active).toBe(1)
    expect(a.paused).toBe(1)
    expect(a.completed).toBe(2)
    expect(a.terminal).toBe(3) // 2 completed + 1 stopped
    expect(a.completionRate).toBeCloseTo(2 / 3)
  })

  it("averages turns/tokens and reports total token spend", () => {
    const a = computeGoalAnalytics(
      [goal({ turnsUsed: 4, tokensUsed: 1000 }), goal({ turnsUsed: 6, tokensUsed: 3000 })],
      { now: NOW }
    )
    expect(a.avgTurns).toBe(5)
    expect(a.avgTokens).toBe(2000)
    expect(a.totalTokens).toBe(4000)
  })

  it("judgeFailureRate = fraction of goals with at least one judge failure", () => {
    const a = computeGoalAnalytics(
      [
        goal({ judgeFailureCount: 0 }),
        goal({ judgeFailureCount: 2 }),
        goal({ judgeFailureCount: 1 }),
      ],
      { now: NOW }
    )
    expect(a.judgeFailureRate).toBeCloseTo(2 / 3)
  })

  it("status distribution follows the canonical order and omits zeros", () => {
    const a = computeGoalAnalytics(
      [goal({ status: "completed" }), goal({ status: "active" }), goal({ status: "completed" })],
      { now: NOW }
    )
    const order = a.statusDistribution.map((s) => s.status)
    expect(order).toEqual(["active", "completed"]) // active precedes completed in STATUS_ORDER
    const completed = a.statusDistribution.find((s) => s.status === "completed")
    expect(completed?.count).toBe(2)
  })
})

describe("computeGoalAnalytics — timeline", () => {
  it("buckets goals into the correct day and sums tokens", () => {
    const a = computeGoalAnalytics(
      [
        goal({ createdAt: NOW, tokensUsed: 100 }), // today
        goal({ createdAt: NOW - 2 * DAY_MS, tokensUsed: 50 }), // 2 days ago
        goal({ createdAt: NOW - 2 * DAY_MS, tokensUsed: 25 }), // 2 days ago
      ],
      { now: NOW }
    )
    const today = a.timeline[a.timeline.length - 1]
    expect(today.created).toBe(1)
    expect(today.tokens).toBe(100)
    const twoAgo = a.timeline[a.timeline.length - 3]
    expect(twoAgo.created).toBe(2)
    expect(twoAgo.tokens).toBe(75)
  })

  it("drops goals older than the window", () => {
    const a = computeGoalAnalytics([goal({ createdAt: NOW - 90 * DAY_MS })], {
      now: NOW,
      windowDays: 7,
    })
    expect(a.timeline).toHaveLength(7)
    expect(a.timeline.reduce((n, b) => n + b.created, 0)).toBe(0)
  })

  it("honors a custom window length", () => {
    const a = computeGoalAnalytics([], { now: NOW, windowDays: 14 })
    expect(a.timeline).toHaveLength(14)
  })
})
