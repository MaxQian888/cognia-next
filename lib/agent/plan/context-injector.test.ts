import type { AgentPlan } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import { appendPlanContext } from "./context-injector"
import { PLAN_SECTION_MARKER } from "./prompts"

function plan(status: AgentPlan["status"]): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses_a",
    title: "Ship it",
    source: "manual",
    executionMode: "auto",
    steps: [
      {
        id: "s1",
        title: "step one",
        kind: "agent_turn",
        status: "in_progress",
        order: 0,
        dependencies: [],
      },
    ],
    status,
    totalSteps: 1,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "gen",
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("appendPlanContext", () => {
  it("appends the plan section when the plan is executing", () => {
    const out = appendPlanContext({ activePlan: plan("executing") })
    expect(out).toContain(PLAN_SECTION_MARKER)
  })

  it("returns the input unchanged when there is no plan", () => {
    expect(appendPlanContext({ appendSystemPrompt: "base", activePlan: null })).toBe("base")
    expect(appendPlanContext({ activePlan: undefined })).toBeUndefined()
  })

  it.each(["draft", "awaiting_approval", "approved", "paused", "completed", "cancelled"] as const)(
    "does not inject for non-executing status %s",
    (status) => {
      expect(appendPlanContext({ appendSystemPrompt: "base", activePlan: plan(status) })).toBe(
        "base"
      )
    }
  )

  it("joins an existing section with two newlines", () => {
    const out = appendPlanContext({ appendSystemPrompt: "base", activePlan: plan("executing") })
    expect(out?.startsWith("base\n\n")).toBe(true)
  })

  it("does not start with the joiner when the existing section is whitespace", () => {
    const out = appendPlanContext({ appendSystemPrompt: "   ", activePlan: plan("executing") })
    expect(out?.startsWith(PLAN_SECTION_MARKER)).toBe(true)
  })
})
