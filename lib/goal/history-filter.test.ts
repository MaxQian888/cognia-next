import type { Goal, GoalStatus } from "@/types/goal"
import { filterAndSortGoals } from "./history-filter"

function goal(overrides: Partial<Goal> = {}): Goal {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    sessionId: "ses",
    rawObjective: "obj",
    safeObjective: "obj",
    redactionMapEnc: "",
    status: "completed",
    turnsUsed: 0,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
    generationId: "gen",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("filterAndSortGoals — filter", () => {
  const goals = [
    goal({ safeObjective: "Review the PR", status: "completed", createdAt: 100 }),
    goal({ safeObjective: "Summarise my week", status: "active", createdAt: 200 }),
    goal({ safeObjective: "review my emails", status: "paused", createdAt: 300 }),
  ]

  it("returns all goals (newest-first) with no filter", () => {
    const r = filterAndSortGoals(goals)
    expect(r.map((g) => g.createdAt)).toEqual([300, 200, 100])
  })

  it("matches the query case-insensitively against safeObjective", () => {
    const r = filterAndSortGoals(goals, { query: "REVIEW" })
    expect(r).toHaveLength(2)
    expect(r.every((g) => g.safeObjective.toLowerCase().includes("review"))).toBe(true)
  })

  it("filters by status allow-list", () => {
    const r = filterAndSortGoals(goals, { statuses: ["active", "paused"] })
    expect(r.map((g) => g.status).sort()).toEqual(["active", "paused"])
  })

  it("empty status list means all", () => {
    expect(filterAndSortGoals(goals, { statuses: [] })).toHaveLength(3)
  })

  it("does not mutate the input array", () => {
    const input = [...goals]
    filterAndSortGoals(input, { sort: "created", dir: "asc" })
    expect(input).toEqual(goals)
  })
})

describe("filterAndSortGoals — sort", () => {
  const goals = [
    goal({ turnsUsed: 5, tokensUsed: 300, createdAt: 100 }),
    goal({ turnsUsed: 1, tokensUsed: 900, createdAt: 200 }),
    goal({ turnsUsed: 9, tokensUsed: 100, createdAt: 300 }),
  ]

  it("sorts by turns ascending", () => {
    const r = filterAndSortGoals(goals, { sort: "turns", dir: "asc" })
    expect(r.map((g) => g.turnsUsed)).toEqual([1, 5, 9])
  })

  it("sorts by tokens descending", () => {
    const r = filterAndSortGoals(goals, { sort: "tokens", dir: "desc" })
    expect(r.map((g) => g.tokensUsed)).toEqual([900, 300, 100])
  })

  it("sorts by created descending by default", () => {
    const r = filterAndSortGoals(goals)
    expect(r.map((g) => g.createdAt)).toEqual([300, 200, 100])
  })

  it("tiebreaks equal sort values by createdAt deterministically", () => {
    const tied = [
      goal({ turnsUsed: 3, createdAt: 100 }),
      goal({ turnsUsed: 3, createdAt: 300 }),
      goal({ turnsUsed: 3, createdAt: 200 }),
    ]
    const r = filterAndSortGoals(tied, { sort: "turns", dir: "asc" })
    expect(r.map((g) => g.createdAt)).toEqual([100, 200, 300])
  })
})
