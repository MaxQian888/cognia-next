import {
  PLAN_REFINEMENT_PROMPTS,
  isTerminalStepStatus,
  type CreatePlanStepInput,
  type PlanStep,
} from "@/types/agent/plan"
import { allStepsTerminal, applyStepStatus, materializeSteps } from "./steps"

function input(over: Partial<CreatePlanStepInput> = {}): CreatePlanStepInput {
  return { title: over.title ?? "step", kind: over.kind ?? "agent_turn", ...over }
}

describe("materializeSteps", () => {
  it("assigns ids, 0-based order, pending status, and zero attempts", () => {
    const steps = materializeSteps([input({ title: "a" }), input({ title: "b" })])
    expect(steps).toHaveLength(2)
    expect(steps[0].order).toBe(0)
    expect(steps[1].order).toBe(1)
    expect(steps.every((s) => s.status === "pending")).toBe(true)
    expect(steps.every((s) => s.attempts === 0)).toBe(true)
    expect(new Set(steps.map((s) => s.id)).size).toBe(2)
  })

  it("resolves dependsOn indices into dependency ids", () => {
    const steps = materializeSteps([input({ title: "a" }), input({ title: "b", dependsOn: [0] })])
    expect(steps[1].dependencies).toEqual([steps[0].id])
  })

  it("drops self-refs and out-of-range / non-integer dep indices", () => {
    const steps = materializeSteps([
      input({ title: "a", dependsOn: [0, 5, -1, 1.5 as unknown as number] }),
      input({ title: "b", dependsOn: [0] }),
    ])
    expect(steps[0].dependencies).toEqual([]) // 0 is self, others invalid
    expect(steps[1].dependencies).toEqual([steps[0].id])
  })

  it("carries params and estimatedDurationMs through", () => {
    const steps = materializeSteps([
      input({
        kind: "tool_call",
        params: { kind: "tool_call", toolName: "Read", input: {} },
        estimatedDurationMs: 1000,
      }),
    ])
    expect(steps[0].params).toEqual({ kind: "tool_call", toolName: "Read", input: {} })
    expect(steps[0].estimatedDurationMs).toBe(1000)
  })
})

describe("applyStepStatus", () => {
  const base: PlanStep[] = materializeSteps([
    input({ title: "a" }),
    input({ title: "b" }),
    input({ title: "c" }),
  ])

  it("sets the status and recomputes completed count", () => {
    const r = applyStepStatus(base, base[0].id, "completed")
    expect(r.steps[0].status).toBe("completed")
    expect(r.completedSteps).toBe(1)
    expect(r.totalSteps).toBe(3)
  })

  it("applies the field patch alongside the status", () => {
    const r = applyStepStatus(base, base[0].id, "failed", { error: "boom", attempts: 2 })
    expect(r.steps[0].error).toBe("boom")
    expect(r.steps[0].attempts).toBe(2)
  })

  it("points currentStepId at the in_progress step when present", () => {
    const r = applyStepStatus(base, base[1].id, "in_progress")
    expect(r.currentStepId).toBe(base[1].id)
  })

  it("falls back to the first non-terminal step in order", () => {
    const r = applyStepStatus(base, base[0].id, "completed")
    expect(r.currentStepId).toBe(base[1].id)
  })

  it("yields undefined currentStepId when all steps are terminal", () => {
    let steps = base
    for (const s of base) steps = applyStepStatus(steps, s.id, "completed").steps
    const r = applyStepStatus(steps, base[2].id, "completed")
    expect(r.currentStepId).toBeUndefined()
  })
})

describe("allStepsTerminal", () => {
  it("is false while any step is non-terminal", () => {
    const steps = materializeSteps([input(), input()])
    expect(allStepsTerminal({ steps })).toBe(false)
  })

  it("is true when every step is completed / failed / skipped", () => {
    const steps = materializeSteps([input(), input(), input()])
    steps[0].status = "completed"
    steps[1].status = "failed"
    steps[2].status = "skipped"
    expect(allStepsTerminal({ steps })).toBe(true)
  })
})

describe("type helpers", () => {
  it("isTerminalStepStatus matches the terminal set", () => {
    expect(isTerminalStepStatus("completed")).toBe(true)
    expect(isTerminalStepStatus("failed")).toBe(true)
    expect(isTerminalStepStatus("skipped")).toBe(true)
    expect(isTerminalStepStatus("pending")).toBe(false)
    expect(isTerminalStepStatus("in_progress")).toBe(false)
  })

  it("PLAN_REFINEMENT_PROMPTS covers every refinement type including repair", () => {
    expect(Object.keys(PLAN_REFINEMENT_PROMPTS).sort()).toEqual([
      "expand",
      "optimize",
      "reorder",
      "repair",
      "simplify",
    ])
  })
})
