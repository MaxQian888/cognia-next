import type { Goal } from "@/types/goal"
import {
  OPEN_GOAL_SCOPES,
  countOpenGoalScopes,
  filterOpenGoals,
  isAwaitingAcceptance,
  isOpenGoal,
  isOpenGoalScope,
  splitOpenGoals,
} from "./overview-filter"

let seq = 0
function goal(overrides: Partial<Goal> = {}): Goal {
  seq += 1
  return {
    id: `g${seq}`,
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
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

describe("scope helpers", () => {
  it("orders the scopes all · active · paused", () => {
    expect(OPEN_GOAL_SCOPES).toEqual(["all", "active", "paused"])
  })

  it("guards scope values", () => {
    expect(isOpenGoalScope("paused")).toBe(true)
    expect(isOpenGoalScope("completed")).toBe(false)
    expect(isOpenGoalScope(1)).toBe(false)
  })

  it("isOpenGoal admits active and paused only", () => {
    expect(isOpenGoal({ status: "active" })).toBe(true)
    expect(isOpenGoal({ status: "paused" })).toBe(true)
    expect(isOpenGoal({ status: "completed" })).toBe(false)
    expect(isOpenGoal({ status: "stopped" } as Pick<Goal, "status">)).toBe(false)
  })
})

describe("isAwaitingAcceptance", () => {
  it("is true only for a paused goal flagged awaitingAcceptance", () => {
    expect(isAwaitingAcceptance({ status: "paused", awaitingAcceptance: true })).toBe(true)
    expect(isAwaitingAcceptance({ status: "paused", awaitingAcceptance: false })).toBe(false)
    expect(isAwaitingAcceptance({ status: "paused" })).toBe(false)
    expect(isAwaitingAcceptance({ status: "active", awaitingAcceptance: true })).toBe(false)
    expect(isAwaitingAcceptance({ status: "completed", awaitingAcceptance: true })).toBe(false)
  })
})

describe("splitOpenGoals", () => {
  it("splits awaiting goals off oldest-first by updatedAt and drops terminal goals", () => {
    const newerAwait = goal({ status: "paused", awaitingAcceptance: true, updatedAt: 300 })
    const olderAwait = goal({ status: "paused", awaitingAcceptance: true, updatedAt: 100 })
    const active = goal({ status: "active" })
    const paused = goal({ status: "paused" })
    const done = goal({ status: "completed", awaitingAcceptance: true })
    const { awaiting, running } = splitOpenGoals([newerAwait, active, done, olderAwait, paused])
    expect(awaiting.map((g) => g.id)).toEqual([olderAwait.id, newerAwait.id])
    expect(running.map((g) => g.id)).toEqual([active.id, paused.id])
  })

  it("does not mutate the input", () => {
    const input = [
      goal({ status: "paused", awaitingAcceptance: true, updatedAt: 9 }),
      goal({ status: "paused", awaitingAcceptance: true, updatedAt: 1 }),
    ]
    const snapshot = input.map((g) => g.id)
    splitOpenGoals(input)
    expect(input.map((g) => g.id)).toEqual(snapshot)
  })
})

describe("countOpenGoalScopes", () => {
  it("counts each scope over the running list", () => {
    const running = [
      goal({ status: "active" }),
      goal({ status: "active" }),
      goal({ status: "paused" }),
    ]
    expect(countOpenGoalScopes(running)).toEqual({ all: 3, active: 2, paused: 1 })
  })

  it("is all zeros for an empty list", () => {
    expect(countOpenGoalScopes([])).toEqual({ all: 0, active: 0, paused: 0 })
  })
})

describe("filterOpenGoals", () => {
  const a = goal({
    status: "active",
    safeObjective: "Ship the release",
    createdAt: 100,
    tokensUsed: 50,
  })
  const b = goal({
    status: "paused",
    safeObjective: "Review the release notes",
    createdAt: 200,
    tokensUsed: 10,
  })
  const c = goal({ status: "active", safeObjective: "Tidy inbox", createdAt: 300, tokensUsed: 30 })
  const running = [a, b, c]

  it("admits every goal in the all scope, newest first by default", () => {
    expect(filterOpenGoals(running, { scope: "all" }).map((g) => g.id)).toEqual([c.id, b.id, a.id])
  })

  it("narrows by scope", () => {
    expect(filterOpenGoals(running, { scope: "active" }).map((g) => g.id)).toEqual([c.id, a.id])
    expect(filterOpenGoals(running, { scope: "paused" }).map((g) => g.id)).toEqual([b.id])
  })

  it("applies the query case-insensitively within the scope", () => {
    expect(filterOpenGoals(running, { scope: "all", query: "RELEASE" }).map((g) => g.id)).toEqual([
      b.id,
      a.id,
    ])
    expect(
      filterOpenGoals(running, { scope: "active", query: "release" }).map((g) => g.id)
    ).toEqual([a.id])
  })

  it("honours sort and direction", () => {
    expect(
      filterOpenGoals(running, { scope: "all", sort: "tokens", dir: "asc" }).map((g) => g.id)
    ).toEqual([b.id, c.id, a.id])
  })
})
