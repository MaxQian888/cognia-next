import type { Goal, GoalConfig } from "@/types/goal"
import { evaluateExitConditions } from "./exit-conditions"

const SAMPLE_CONFIG: GoalConfig = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
}

// Anchor every fixture goal at "now-ish" so the timeout exit doesn't trip
// silently on the rest of the matrix. Tests that exercise timeout pin
// `createdAt: 0` explicitly and supply a sentinel `now`.
const NOW_BASELINE = Date.now()

function buildGoal(overrides: Partial<Goal> = {}): Goal {
  const now = NOW_BASELINE
  return {
    id: "g1",
    sessionId: "ses_a",
    rawObjective: "x",
    safeObjective: "x",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 0,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: SAMPLE_CONFIG,
    generationId: "gen-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("evaluateExitConditions — individual triggers", () => {
  it("returns null when no condition fires", () => {
    expect(evaluateExitConditions(buildGoal())).toBeNull()
  })

  it("user_stopped → status=stopped", () => {
    const result = evaluateExitConditions(buildGoal(), { userStopRequested: true })
    expect(result).toEqual({
      exit: "user_stopped",
      resultingStatus: "stopped",
      reason: expect.stringContaining("/goal stop"),
    })
  })

  it("preempted → status=preempted", () => {
    const result = evaluateExitConditions(buildGoal(), { userPreempted: true })
    expect(result?.exit).toBe("preempted")
    expect(result?.resultingStatus).toBe("preempted")
  })

  it("turn_limited fires at exactly maxTurns", () => {
    const goal = buildGoal({ turnsUsed: 20 })
    const result = evaluateExitConditions(goal)
    expect(result?.exit).toBe("turn_limited")
    expect(result?.resultingStatus).toBe("turn_limited")
    expect(result?.reason).toMatch(/20\/20/)
  })

  it("turn_limited does NOT fire at maxTurns - 1", () => {
    expect(evaluateExitConditions(buildGoal({ turnsUsed: 19 }))).toBeNull()
  })

  it("budget_limited fires when tokensUsed >= maxTokens", () => {
    const goal = buildGoal({ tokensUsed: 200_000 })
    const result = evaluateExitConditions(goal)
    expect(result?.exit).toBe("budget_limited")
    expect(result?.resultingStatus).toBe("budget_limited")
  })

  it("budget_limited does NOT fire when tokensUsed < maxTokens", () => {
    expect(evaluateExitConditions(buildGoal({ tokensUsed: 199_999 }))).toBeNull()
  })

  it("timed_out fires after timeoutMs", () => {
    const goal = buildGoal({ createdAt: 0 })
    const now = goal.config.timeoutMs + 1
    const result = evaluateExitConditions(goal, { now })
    expect(result?.exit).toBe("timed_out")
    expect(result?.resultingStatus).toBe("timed_out")
    expect(result?.reason).toMatch(/timeout/)
  })

  it("timed_out does NOT fire just before timeoutMs", () => {
    const goal = buildGoal({ createdAt: 0 })
    const result = evaluateExitConditions(goal, { now: goal.config.timeoutMs - 1 })
    expect(result).toBeNull()
  })

  it("judge_failed_too_many → paused (NOT terminal)", () => {
    const goal = buildGoal({ judgeFailureCount: 3 })
    const result = evaluateExitConditions(goal)
    expect(result?.exit).toBe("judge_failed_too_many")
    expect(result?.resultingStatus).toBe("paused")
  })

  it("judge_failed_too_many does NOT fire below threshold", () => {
    expect(evaluateExitConditions(buildGoal({ judgeFailureCount: 2 }))).toBeNull()
  })

  it("judge_done fires when judge says done=true", () => {
    const result = evaluateExitConditions(buildGoal(), {
      judgeDecision: { done: true, reason: "haiku produced" },
    })
    expect(result?.exit).toBe("judge_done")
    expect(result?.resultingStatus).toBe("completed")
    expect(result?.reason).toBe("haiku produced")
  })

  it("judge_done falls back to a generic reason when judge omits one", () => {
    const result = evaluateExitConditions(buildGoal(), {
      judgeDecision: { done: true, reason: "" },
    })
    expect(result?.reason).toMatch(/objective satisfied/)
  })

  it("judge done=false continues the loop (returns null)", () => {
    const result = evaluateExitConditions(buildGoal(), {
      judgeDecision: { done: false, reason: "still going" },
    })
    expect(result).toBeNull()
  })
})

describe("evaluateExitConditions — priority order", () => {
  it("user_stopped beats every other trigger", () => {
    const goal = buildGoal({
      turnsUsed: 999,
      tokensUsed: 999_999,
      judgeFailureCount: 99,
      createdAt: 0,
    })
    const result = evaluateExitConditions(goal, {
      userStopRequested: true,
      userPreempted: true,
      now: 999_999_999,
      judgeDecision: { done: true, reason: "x" },
    })
    expect(result?.exit).toBe("user_stopped")
  })

  it("preempted beats turn / token / timeout / judge exits", () => {
    const goal = buildGoal({
      turnsUsed: 999,
      tokensUsed: 999_999,
      judgeFailureCount: 99,
      createdAt: 0,
    })
    const result = evaluateExitConditions(goal, {
      userPreempted: true,
      now: 999_999_999,
      judgeDecision: { done: true, reason: "x" },
    })
    expect(result?.exit).toBe("preempted")
  })

  it("turn_limited beats budget / timeout / judge", () => {
    const goal = buildGoal({
      turnsUsed: 20,
      tokensUsed: 999_999,
      judgeFailureCount: 99,
      createdAt: 0,
    })
    const result = evaluateExitConditions(goal, {
      now: 999_999_999,
      judgeDecision: { done: true, reason: "x" },
    })
    expect(result?.exit).toBe("turn_limited")
  })

  it("budget_limited beats timeout / judge", () => {
    const goal = buildGoal({
      tokensUsed: 200_000,
      judgeFailureCount: 99,
      createdAt: 0,
    })
    const result = evaluateExitConditions(goal, {
      now: 999_999_999,
      judgeDecision: { done: true, reason: "x" },
    })
    expect(result?.exit).toBe("budget_limited")
  })

  it("timed_out beats judge_failed_too_many and judge_done", () => {
    const goal = buildGoal({
      createdAt: 0,
      judgeFailureCount: 99,
    })
    const result = evaluateExitConditions(goal, {
      now: goal.config.timeoutMs + 1,
      judgeDecision: { done: true, reason: "x" },
    })
    expect(result?.exit).toBe("timed_out")
  })

  it("judge_failed_too_many beats judge_done", () => {
    const goal = buildGoal({ judgeFailureCount: 3 })
    const result = evaluateExitConditions(goal, {
      judgeDecision: { done: true, reason: "x" },
    })
    expect(result?.exit).toBe("judge_failed_too_many")
  })
})

describe("evaluateExitConditions — defaults", () => {
  it("uses Date.now() when ctx.now is omitted", () => {
    const goal = buildGoal({ createdAt: Date.now() - 60_000 })
    // 60s elapsed, well under 30 min default — should not fire
    expect(evaluateExitConditions(goal)).toBeNull()
  })

  it("ctx defaults to {} when omitted entirely", () => {
    expect(evaluateExitConditions(buildGoal())).toBeNull()
  })
})
