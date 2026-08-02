import { isLinearAgentTurnPlan, resolvePlanStrategy, type StrategyInput } from "./strategy"
import type { PlanStep, PlanStepKind } from "@/types/agent/plan"

/** Build a chain of `n` steps where each depends on its predecessor. */
function chain(n: number, kind: PlanStepKind = "agent_turn"): PlanStep[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    title: `step ${i}`,
    kind,
    status: "pending" as const,
    order: i,
    dependencies: i > 0 ? [`s${i - 1}`] : [],
  }))
}

function input(over: Partial<StrategyInput> = {}): StrategyInput {
  return {
    executionMode: over.executionMode ?? "auto",
    steps: over.steps ?? chain(3),
    source: over.source ?? "manual",
  }
}

describe("isLinearAgentTurnPlan", () => {
  it("accepts a predecessor chain", () => {
    expect(isLinearAgentTurnPlan(chain(3))).toBe(true)
  })

  it("accepts a flat list with no dependencies at all", () => {
    const steps = chain(3).map((s) => ({ ...s, dependencies: [] }))
    expect(isLinearAgentTurnPlan(steps)).toBe(true)
  })

  it("accepts a single step", () => {
    expect(isLinearAgentTurnPlan(chain(1))).toBe(true)
  })

  it("rejects an empty plan", () => {
    expect(isLinearAgentTurnPlan([])).toBe(false)
  })

  it.each([
    "teammate_dispatch",
    "tool_call",
    "mcp_tool_call",
    "sub_workflow",
    "approval_gate",
  ] as const)("rejects a plan containing a %s step", (kind) => {
    const steps = chain(2)
    steps[1] = { ...steps[1], kind }
    expect(isLinearAgentTurnPlan(steps)).toBe(false)
  })

  it("rejects a join (a step with two dependencies)", () => {
    const steps = chain(3)
    steps[2] = { ...steps[2], dependencies: ["s0", "s1"] }
    expect(isLinearAgentTurnPlan(steps)).toBe(false)
  })

  it("rejects a skip edge (depends on a non-immediate predecessor)", () => {
    const steps = chain(3)
    steps[2] = { ...steps[2], dependencies: ["s0"] }
    expect(isLinearAgentTurnPlan(steps)).toBe(false)
  })

  it("rejects a first step that already has a dependency", () => {
    const steps = chain(2)
    steps[0] = { ...steps[0], dependencies: ["s1"] }
    expect(isLinearAgentTurnPlan(steps)).toBe(false)
  })

  it("sorts by `order`, not array position", () => {
    const steps = [...chain(3)].reverse()
    expect(isLinearAgentTurnPlan(steps)).toBe(true)
  })
})

describe("resolvePlanStrategy", () => {
  it("honours an explicit in_session mode even for a fan-out plan", () => {
    const steps = chain(3)
    steps[2] = { ...steps[2], dependencies: ["s0", "s1"] }
    expect(resolvePlanStrategy(input({ executionMode: "in_session", steps }))).toBe("in_session")
  })

  it("honours an explicit orchestrated mode even for a linear plan", () => {
    expect(resolvePlanStrategy(input({ executionMode: "orchestrated" }))).toBe("orchestrated")
  })

  it.each(["manual", "planner_llm", "goal_projection", "agent_tool"] as const)(
    "auto + linear + source %s → in_session",
    (source) => {
      expect(resolvePlanStrategy(input({ source }))).toBe("in_session")
    }
  )

  it("auto + linear + exit_plan_mode → orchestrated (Claude-Code parity carve-out)", () => {
    expect(resolvePlanStrategy(input({ source: "exit_plan_mode" }))).toBe("orchestrated")
  })

  it("auto + non-linear → orchestrated regardless of source", () => {
    const steps = chain(2, "teammate_dispatch")
    expect(resolvePlanStrategy(input({ steps, source: "manual" }))).toBe("orchestrated")
  })

  it("auto + empty plan → orchestrated (nothing for the driver to advance)", () => {
    expect(resolvePlanStrategy(input({ steps: [] }))).toBe("orchestrated")
  })
})
