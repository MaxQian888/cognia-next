import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import { PlanSynthesizeError, synthesizePlanWorkflow } from "./synthesize-workflow"

function step(id: string, deps: string[] = [], over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: over.title ?? `step ${id}`,
    kind: over.kind ?? "agent_turn",
    status: "pending",
    order: over.order ?? 0,
    dependencies: deps,
    params: over.params,
  }
}

function plan(steps: PlanStep[], over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: over.id ?? "p1",
    sessionId: "ses_a",
    title: over.title ?? "My plan",
    description: over.description,
    source: "manual",
    executionMode: "auto",
    steps,
    status: "approved",
    totalSteps: steps.length,
    completedSteps: 0,
    config: over.config ?? DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "gen",
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("synthesizePlanWorkflow", () => {
  it("emits one action.plan.step.dispatch node per step with plan/step params", () => {
    const { workflow, nodeIdToStepId } = synthesizePlanWorkflow(plan([step("a"), step("b", ["a"])]))
    expect(workflow.nodes).toHaveLength(2)
    expect(workflow.nodes[0].type).toBe("action.plan.step.dispatch")
    expect(workflow.nodes[0].data.params).toMatchObject({
      planId: "p1",
      stepId: "a",
      stepKind: "agent_turn",
    })
    expect(nodeIdToStepId.get("a")).toBe("a")
  })

  it("encodes dependencies as edges", () => {
    const { workflow } = synthesizePlanWorkflow(plan([step("a"), step("b", ["a"])]))
    expect(workflow.edges).toEqual([{ id: "a->b", source: "a", target: "b" }])
  })

  it("uses a __plan__: prefixed id and the plan title/description", () => {
    const { workflow } = synthesizePlanWorkflow(
      plan([step("a")], { id: "px", title: "T", description: "D" })
    )
    expect(workflow.id.startsWith("__plan__:px:")).toBe(true)
    expect(workflow.name).toBe("T")
    expect(workflow.description).toBe("D")
  })

  it("honors config.maxConcurrency / errorPolicy in settings", () => {
    const { workflow } = synthesizePlanWorkflow(
      plan([step("a")], {
        config: { ...DEFAULT_PLAN_CONFIG, maxConcurrency: 4, errorPolicy: "continue" },
      })
    )
    expect(workflow.settings.maxConcurrency).toBe(4)
    expect(workflow.settings.errorPolicy).toBe("continue")
  })

  it("defaults maxConcurrency to 1 when unset/zero", () => {
    const { workflow } = synthesizePlanWorkflow(
      plan([step("a")], { config: { ...DEFAULT_PLAN_CONFIG, maxConcurrency: 0 } })
    )
    expect(workflow.settings.maxConcurrency).toBe(1)
  })

  it("throws on an empty plan", () => {
    expect(() => synthesizePlanWorkflow(plan([]))).toThrow(PlanSynthesizeError)
    try {
      synthesizePlanWorkflow(plan([]))
    } catch (e) {
      expect((e as PlanSynthesizeError).reason).toBe("empty")
    }
  })

  it("throws invalid_dep for an unknown dependency id", () => {
    try {
      synthesizePlanWorkflow(plan([step("a", ["ghost"])]))
      throw new Error("expected throw")
    } catch (e) {
      expect((e as PlanSynthesizeError).reason).toBe("invalid_dep")
    }
  })

  it("throws cycle when the dependency graph has a cycle", () => {
    try {
      synthesizePlanWorkflow(plan([step("a", ["b"]), step("b", ["a"])]))
      throw new Error("expected throw")
    } catch (e) {
      expect((e as PlanSynthesizeError).reason).toBe("cycle")
    }
  })
})
