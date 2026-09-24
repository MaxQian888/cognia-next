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

describe("applyPlanComposerEdit", () => {
  const step = (id: string, order: number, over: Record<string, unknown> = {}) => ({
    id,
    title: `t${order}`,
    kind: "agent_turn" as const,
    status: "pending" as const,
    order,
    dependencies: [] as string[],
    ...over,
  })

  beforeEach(() => updatePlanDraft.mockClear())

  it("applies a same-length edit in place, keeping ids and the DAG", async () => {
    const { applyPlanComposerEdit } = await import("./draft-edit")
    const source = plan({
      source: "agent_tool",
      steps: [step("a", 0), step("b", 1), step("c", 2, { dependencies: ["a"] })],
    })
    await applyPlanComposerEdit(source, {
      title: "  New title ",
      steps: [
        { title: "t0", kind: "agent_turn" },
        {
          title: "renamed",
          kind: "approval_gate",
          params: { kind: "approval_gate", prompt: "ok?" },
        },
        { title: "t2", kind: "agent_turn" },
      ],
    })
    const [id, patch] = updatePlanDraft.mock.calls[0]
    expect(id).toBe("p1")
    expect(patch.title).toBe("New title")
    expect(patch.steps.map((s: { id: string }) => s.id)).toEqual(["a", "b", "c"])
    expect(patch.steps[1]).toMatchObject({ title: "renamed", kind: "approval_gate" })
    // The authored parallel edge survives the edit.
    expect(patch.steps[2].dependencies).toEqual(["a"])
    expect(patch.metadata).toMatchObject({ existing: true, userEdited: true })
  })

  it("re-derives a linear chain when the step count changes", async () => {
    const { applyPlanComposerEdit } = await import("./draft-edit")
    await applyPlanComposerEdit(plan({ steps: [step("a", 0)] }), {
      title: "x",
      steps: [
        { title: "one", kind: "agent_turn" },
        { title: "two", kind: "agent_turn" },
      ],
    })
    const [, patch] = updatePlanDraft.mock.calls[0]
    expect(patch.steps).toHaveLength(2)
    expect(patch.steps[1].dependencies).toEqual([patch.steps[0].id])
  })

  it("rewrites a captured markdown body's steps section to match", async () => {
    const { applyPlanComposerEdit } = await import("./draft-edit")
    await applyPlanComposerEdit(
      plan({
        steps: [step("a", 0, { title: "alpha" })],
        metadata: { planText: "# Plan\n\n## Steps\n\n1. alpha\n" },
      }),
      { title: "Plan", steps: [{ title: "omega", kind: "agent_turn" }] }
    )
    const [, patch] = updatePlanDraft.mock.calls[0]
    expect(patch.metadata.planText).toContain("1. omega")
    expect(patch.metadata.planText).not.toContain("alpha")
  })

  it("leaves steps untouched on a title-only edit", async () => {
    const { applyPlanComposerEdit } = await import("./draft-edit")
    await applyPlanComposerEdit(plan({ steps: [step("a", 0)] }), {
      title: "Only the title",
      steps: [{ title: "t0", kind: "agent_turn" }],
    })
    const [, patch] = updatePlanDraft.mock.calls[0]
    expect(patch.steps).toBeUndefined()
  })

  it("re-validates: refuses an empty plan and a step its kind cannot run", async () => {
    const { applyPlanComposerEdit, PlanEditValidationError } = await import("./draft-edit")
    await expect(applyPlanComposerEdit(plan(), { title: "x", steps: [] })).rejects.toBeInstanceOf(
      PlanEditValidationError
    )
    await expect(
      applyPlanComposerEdit(plan(), {
        title: "x",
        steps: [
          { title: "ok", kind: "agent_turn" },
          {
            title: "broken",
            kind: "sub_workflow",
            params: { kind: "sub_workflow", workflowId: "  " },
          },
        ],
      })
    ).rejects.toMatchObject({ reason: "invalid_step", stepIndex: 2 })
    expect(updatePlanDraft).not.toHaveBeenCalled()
  })
})
