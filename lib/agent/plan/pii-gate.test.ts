import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import { findPlanPiiLeak } from "./pii-gate"

function step(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: over.id ?? "s1",
    title: over.title ?? "clean step",
    description: over.description,
    kind: over.kind ?? "agent_turn",
    status: "pending",
    order: over.order ?? 0,
    dependencies: [],
    params: over.params,
    result: over.result,
  }
}

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses_a",
    title: over.title ?? "Clean plan",
    description: over.description,
    source: "manual",
    executionMode: "auto",
    steps: over.steps ?? [step()],
    status: "draft",
    totalSteps: 1,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "gen",
    createdAt: 0,
    updatedAt: 0,
  }
}

const EMAIL = "leak@example.com"

describe("findPlanPiiLeak", () => {
  it("returns null for a clean plan", () => {
    expect(findPlanPiiLeak(plan())).toBeNull()
  })

  it("flags the plan title", () => {
    expect(findPlanPiiLeak(plan({ title: `contact ${EMAIL}` }))).toBe("title")
  })

  it("flags the plan description", () => {
    expect(findPlanPiiLeak(plan({ description: `see ${EMAIL}` }))).toBe("description")
  })

  it("flags a step title", () => {
    const leak = findPlanPiiLeak(plan({ steps: [step({ id: "x", title: `email ${EMAIL}` })] }))
    expect(leak).toBe("step:x:title")
  })

  it("flags a step result text", () => {
    const leak = findPlanPiiLeak(plan({ steps: [step({ id: "x", result: `sent to ${EMAIL}` })] }))
    expect(leak).toBe("step:x:text")
  })

  it("deep-scans step params for smuggled PII", () => {
    const leak = findPlanPiiLeak(
      plan({
        steps: [
          step({
            id: "x",
            kind: "tool_call",
            params: { kind: "tool_call", toolName: "Send", input: { to: EMAIL } },
          }),
        ],
      })
    )
    expect(leak).toBe("step:x:params")
  })
})
