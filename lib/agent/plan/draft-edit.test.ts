/**
 * @jest-environment jsdom
 */

import { applyPlanEditPatch, linearSteps } from "./draft-edit"
import type { AgentPlan } from "@/types/agent/plan"

const updatePlanDraft = jest.fn().mockResolvedValue(null)
jest.mock("./runtime", () => ({
  getPlanRuntime: () => ({ updatePlanDraft }),
}))

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses",
    projectId: "proj",
    title: "Ship it",
    source: "exit_plan_mode",
    status: "awaiting_approval",
    executionMode: "in_session",
    refinementCount: 0,
    config: { errorPolicy: "stop", maxConcurrency: 1 },
    steps: [],
    metadata: { existing: true },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as AgentPlan
}

describe("applyPlanEditPatch", () => {
  beforeEach(() => updatePlanDraft.mockClear())

  it("re-derives linear steps from a rewritten markdown body and keeps planText", async () => {
    await applyPlanEditPatch(plan(), {
      title: "Renamed",
      planText: "## Plan\n\n1. alpha\n2. beta\n\n> a quote, not a step\n",
    })
    const [id, patch] = updatePlanDraft.mock.calls[0]
    expect(id).toBe("p1")
    expect(patch.title).toBe("Renamed")
    expect(patch.steps.map((s: { title: string }) => s.title)).toEqual(["alpha", "beta"])
    // Linear dependency chain — same shape exit-plan-capture produces.
    expect(patch.steps[1].dependencies).toEqual([patch.steps[0].id])
    expect(patch.metadata).toMatchObject({
      existing: true,
      userEdited: true,
      planText: expect.stringContaining("alpha"),
    })
  })

  it("edits step titles directly for plans without a markdown body", async () => {
    await applyPlanEditPatch(plan(), { title: "T", stepTitles: ["a", "b"] })
    const [, patch] = updatePlanDraft.mock.calls[0]
    expect(patch.steps.map((s: { title: string }) => s.title)).toEqual(["a", "b"])
    expect(patch.metadata.userEdited).toBe(true)
    expect(patch.metadata.planText).toBeUndefined()
  })

  it("skips the write when the patch carries no usable steps (never wipes a plan)", async () => {
    await applyPlanEditPatch(plan(), { title: "T", stepTitles: [] })
    await applyPlanEditPatch(plan(), { title: "T", planText: "   \n  " })
    expect(updatePlanDraft).not.toHaveBeenCalled()
  })

  it("does not fabricate a step from prose when a markdown edit removes every list", async () => {
    // Deleting all step rows rewrites the doc with no list at all; the
    // projection must yield zero steps (write refused), not a phantom step
    // named after the document's first line.
    await applyPlanEditPatch(plan(), {
      title: "T",
      planText: "# Ship it\n\nAll prose, no lists.\n",
    })
    expect(updatePlanDraft).not.toHaveBeenCalled()
  })

  it("falls back to the existing title and caps it at 120 chars", async () => {
    await applyPlanEditPatch(plan(), { title: "  ", stepTitles: ["a"] })
    expect(updatePlanDraft.mock.calls[0][1].title).toBe("Ship it")
    await applyPlanEditPatch(plan(), { title: "x".repeat(200), stepTitles: ["a"] })
    expect(updatePlanDraft.mock.calls[1][1].title).toHaveLength(120)
  })

  it("keeps the existing steps when the patch does not change their titles", async () => {
    // A title-only edit must not rebuild steps — rebuilding materializes fresh
    // `agent_turn` rows and would erase kind/params on typed steps (and the
    // step ids `agentPlanEvents` payloads reference).
    const existing = linearSteps(["alpha", "beta"]).map((s, i) => ({
      ...s,
      kind: i === 0 ? ("tool_call" as const) : s.kind,
      order: i,
    }))
    await applyPlanEditPatch(plan({ steps: existing }), {
      title: "Renamed",
      stepTitles: ["alpha", "beta"],
    })
    const [, patch] = updatePlanDraft.mock.calls[0]
    expect(patch.title).toBe("Renamed")
    expect(patch.steps).toBeUndefined()
  })
})

describe("linearSteps", () => {
  it("materializes a sequential agent_turn chain", () => {
    const steps = linearSteps(["one", "two", "three"])
    expect(steps.map((s) => s.title)).toEqual(["one", "two", "three"])
    expect(steps.every((s) => s.kind === "agent_turn")).toBe(true)
    expect(steps[1].dependencies).toEqual([steps[0].id])
    expect(steps[2].dependencies).toEqual([steps[1].id])
  })
})
