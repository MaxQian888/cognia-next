import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import {
  __resetPlanRunContextForTesting,
  getPlanRunContext,
  getRunStep,
  registerPlanRunContext,
  unregisterPlanRunContext,
  type PlanRunContext,
} from "./plan-run-context"

function step(id: string): PlanStep {
  return { id, title: id, kind: "agent_turn", status: "pending", order: 0, dependencies: [] }
}

function ctx(runId: string, steps: PlanStep[]): PlanRunContext {
  const plan: AgentPlan = {
    id: "p1",
    sessionId: "s",
    title: "t",
    source: "manual",
    executionMode: "auto",
    steps,
    status: "executing",
    totalSteps: steps.length,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
  }
  return { runId, planId: "p1", plan, writer: { setStepStatus: async () => {} } }
}

beforeEach(() => __resetPlanRunContextForTesting())

describe("plan-run-context registry", () => {
  it("registers, reads, and unregisters by runId", () => {
    const c = ctx("r1", [step("a")])
    registerPlanRunContext(c)
    expect(getPlanRunContext("r1")).toBe(c)
    unregisterPlanRunContext("r1")
    expect(getPlanRunContext("r1")).toBeUndefined()
  })

  it("returns undefined for an unknown runId", () => {
    expect(getPlanRunContext("nope")).toBeUndefined()
  })

  it("getRunStep finds a step in the snapshot or returns undefined", () => {
    const c = ctx("r1", [step("a"), step("b")])
    expect(getRunStep(c, "b")?.id).toBe("b")
    expect(getRunStep(c, "ghost")).toBeUndefined()
  })

  it("reset clears all entries", () => {
    registerPlanRunContext(ctx("r1", [step("a")]))
    registerPlanRunContext(ctx("r2", [step("a")]))
    __resetPlanRunContextForTesting()
    expect(getPlanRunContext("r1")).toBeUndefined()
    expect(getPlanRunContext("r2")).toBeUndefined()
  })
})
