import type { Goal, GoalConfig, GoalStatus } from "@/types/goal"
import { GOAL_SECTION_MARKER } from "./prompts"
import { appendGoalContext } from "./context-injector"

const SAMPLE_CONFIG: GoalConfig = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
}

function buildGoal(overrides: Partial<Goal> = {}): Goal {
  const now = Date.now()
  return {
    id: "g1",
    sessionId: "ses_a",
    rawObjective: "ship feature flag system",
    safeObjective: "ship feature flag system",
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

describe("appendGoalContext", () => {
  it("returns the input unchanged when activeGoal is null", () => {
    const out = appendGoalContext({ appendSystemPrompt: "existing", activeGoal: null })
    expect(out).toBe("existing")
  })

  it("returns the input unchanged when activeGoal is undefined", () => {
    const out = appendGoalContext({ appendSystemPrompt: "existing" })
    expect(out).toBe("existing")
  })

  it.each<GoalStatus>([
    "paused",
    "completed",
    "stopped",
    "budget_limited",
    "turn_limited",
    "timed_out",
    "preempted",
  ])("does NOT inject when status is %s", (status) => {
    const goal = buildGoal({ status })
    const out = appendGoalContext({ appendSystemPrompt: "existing", activeGoal: goal })
    expect(out).toBe("existing")
  })

  it("injects the goal section when status is active", () => {
    const goal = buildGoal({ status: "active" })
    const out = appendGoalContext({ appendSystemPrompt: undefined, activeGoal: goal })
    expect(out).toContain(GOAL_SECTION_MARKER)
    expect(out).toContain("ship feature flag system")
  })

  it("appends to existing appendSystemPrompt with paragraph separator", () => {
    const goal = buildGoal({ status: "active" })
    const out = appendGoalContext({
      appendSystemPrompt: "[A2UI section]",
      activeGoal: goal,
    })
    expect(out).toMatch(/^\[A2UI section\]\n\n## Active Goal/)
  })

  it("trims whitespace from existing appendSystemPrompt before joining", () => {
    const goal = buildGoal({ status: "active" })
    const out = appendGoalContext({
      appendSystemPrompt: "   [brief]   \n\n",
      activeGoal: goal,
    })
    expect(out).toMatch(/^\[brief\]\n\n## Active Goal/)
  })

  it("returns just the goal section when no existing prompt is present", () => {
    const goal = buildGoal({ status: "active" })
    const out = appendGoalContext({ activeGoal: goal })
    expect(out?.startsWith(GOAL_SECTION_MARKER)).toBe(true)
  })

  it("returns just the goal section when existing prompt is whitespace only", () => {
    const goal = buildGoal({ status: "active" })
    const out = appendGoalContext({ appendSystemPrompt: "   ", activeGoal: goal })
    expect(out?.startsWith(GOAL_SECTION_MARKER)).toBe(true)
  })
})
