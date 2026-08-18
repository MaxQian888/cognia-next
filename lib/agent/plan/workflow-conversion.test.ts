import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import { planInputFromWorkflow, planWorkflowDraft } from "./workflow-conversion"
import { PlanSynthesizeError } from "./synthesize-workflow"

function step(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: over.id ?? "s1",
    title: over.title ?? "step",
    kind: over.kind ?? "agent_turn",
    status: "pending",
    order: over.order ?? 0,
    dependencies: over.dependencies ?? [],
    ...over,
  } as PlanStep
}

function plan(steps: PlanStep[], over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses",
    title: "Ship v2",
    description: "the release",
    source: "manual",
    executionMode: "auto",
    steps,
    status: "awaiting_approval",
    totalSteps: steps.length,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as AgentPlan
}

describe("planWorkflowDraft", () => {
  const linear = () => [
    step({ id: "a", order: 0 }),
    step({ id: "b", order: 1, dependencies: ["a"] }),
  ]

  it("emits a manual trigger feeding every root step", () => {
    const draft = planWorkflowDraft(plan(linear()))
    const trigger = draft.nodes[0]
    expect(trigger.type).toBe("trigger.manual")
    expect(draft.edges[0]).toMatchObject({ source: trigger.id, target: "a" })
    // Only roots are wired to the trigger; "b" keeps its own dependency edge.
    expect(draft.edges.filter((e) => e.source === trigger.id)).toHaveLength(1)
    expect(draft.edges).toContainEqual(expect.objectContaining({ source: "a", target: "b" }))
  })

  it("wires every root when the plan fans out", () => {
    const draft = planWorkflowDraft(
      plan([
        step({ id: "a", order: 0 }),
        step({ id: "b", order: 1 }),
        step({ id: "c", order: 2, dependencies: ["a", "b"] }),
      ])
    )
    const triggerId = draft.nodes[0].id
    expect(draft.edges.filter((e) => e.source === triggerId).map((e) => e.target)).toEqual([
      "a",
      "b",
    ])
  })

  // The synthesizer stacks every node at 0,0 — fine headless, unusable in the
  // canvas. An exported workflow is meant to be opened, so positions must be
  // real and distinct.
  it("lays the steps out by dependency level with no overlaps", () => {
    const draft = planWorkflowDraft(
      plan([
        step({ id: "a", order: 0 }),
        step({ id: "b", order: 1 }),
        step({ id: "c", order: 2, dependencies: ["a"] }),
      ])
    )
    const byId = new Map(draft.nodes.map((n) => [n.id, n.position]))
    expect(byId.get("a")!.x).toBe(byId.get("b")!.x)
    expect(byId.get("a")!.y).not.toBe(byId.get("b")!.y)
    expect(byId.get("c")!.x).toBeGreaterThan(byId.get("a")!.x)
    const seen = new Set(draft.nodes.map((n) => `${n.position.x}:${n.position.y}`))
    expect(seen.size).toBe(draft.nodes.length)
  })

  it("carries the plan's name, description and dispatch nodes", () => {
    const draft = planWorkflowDraft(plan(linear()))
    expect(draft.name).toBe("Ship v2")
    expect(draft.description).toBe("the release")
    expect(draft.tags).toEqual(["plan"])
    expect(draft.nodes.slice(1).every((n) => n.type === "action.plan.step.dispatch")).toBe(true)
  })

  it("refuses a cyclic or empty plan exactly like the run path", () => {
    expect(() => planWorkflowDraft(plan([]))).toThrow(PlanSynthesizeError)
    expect(() =>
      planWorkflowDraft(
        plan([
          step({ id: "a", order: 0, dependencies: ["b"] }),
          step({ id: "b", order: 1, dependencies: ["a"] }),
        ])
      )
    ).toThrow(PlanSynthesizeError)
  })
})

describe("planInputFromWorkflow", () => {
  const wf = { id: "wf_1", name: "Nightly report", description: "sends the digest" }

  it("wraps the workflow in a single orchestrated sub_workflow step", () => {
    const input = planInputFromWorkflow(wf, { sessionId: "ses" })
    expect(input.executionMode).toBe("orchestrated")
    expect(input.metadata).toEqual({ workflowId: "wf_1" })
    expect(input.steps).toHaveLength(1)
    expect(input.steps[0]).toMatchObject({
      kind: "sub_workflow",
      params: { kind: "sub_workflow", workflowId: "wf_1" },
    })
  })

  it("prepends an approval gate the run step depends on", () => {
    const input = planInputFromWorkflow(wf, { sessionId: "ses", withApprovalGate: true })
    expect(input.steps.map((s) => s.kind)).toEqual(["approval_gate", "sub_workflow"])
    expect(input.steps[1].dependsOn).toEqual([0])
  })

  it("keeps the character when the session has one", () => {
    expect(planInputFromWorkflow(wf, { sessionId: "s", characterId: "c1" }).characterId).toBe("c1")
    expect(planInputFromWorkflow(wf, { sessionId: "s" }).characterId).toBeUndefined()
  })
})
