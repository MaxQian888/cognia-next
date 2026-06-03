import type { AgentPlan, PlanStep, PlanStepStatus } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import type { PlanRunContext } from "./plan-run-context"
import { PLAN_APPROVAL_SCOPE, dispatchPlanStepNode, planApprovalKey } from "./step-dispatch"

const executeAgentMock = jest.fn()
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: (...a: unknown[]) => executeAgentMock(...a),
}))

const waitForDecisionMock = jest.fn()
jest.mock("@/lib/runtime/approval-bus", () => ({
  waitForDecision: (...a: unknown[]) => waitForDecisionMock(...a),
}))

const getWorkflowMock = jest.fn()
jest.mock("@/lib/db/workflows", () => ({
  getWorkflow: (...a: unknown[]) => getWorkflowMock(...a),
}))

const runWorkflowMock = jest.fn()
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: (...a: unknown[]) => runWorkflowMock(...a),
}))

function step(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: over.id ?? "s1",
    title: over.title ?? "do the thing",
    description: over.description,
    kind: over.kind ?? "agent_turn",
    status: "pending",
    order: 0,
    dependencies: [],
    params: over.params,
    attempts: over.attempts,
  }
}

function makeCtx(s: PlanStep): {
  ctx: PlanRunContext
  calls: Array<{ stepId: string; status: PlanStepStatus; patch?: Record<string, unknown> }>
} {
  const calls: Array<{ stepId: string; status: PlanStepStatus; patch?: Record<string, unknown> }> =
    []
  const plan: AgentPlan = {
    id: "p1",
    sessionId: "ses",
    characterId: "char_1",
    title: "plan",
    source: "manual",
    executionMode: "auto",
    steps: [s],
    status: "executing",
    totalSteps: 1,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
  }
  const ctx: PlanRunContext = {
    runId: "r1",
    planId: "p1",
    plan,
    characterId: "char_1",
    writer: {
      setStepStatus: async (stepId, status, patch) => {
        calls.push({ stepId, status, patch: patch as Record<string, unknown> })
      },
    },
  }
  return { ctx, calls }
}

beforeEach(() => {
  executeAgentMock.mockReset()
  waitForDecisionMock.mockReset()
  getWorkflowMock.mockReset()
  runWorkflowMock.mockReset()
})

const signal = new AbortController().signal

describe("planApprovalKey", () => {
  it("namespaces by plan + step under the plan scope", () => {
    expect(planApprovalKey("p1", "s9")).toEqual({ scope: PLAN_APPROVAL_SCOPE, id: "p1:s9" })
  })
})

describe("dispatchPlanStepNode — agent_turn", () => {
  it("runs executeAgent tool-enabled as the plan character and marks completed", async () => {
    executeAgentMock.mockResolvedValue({ text: "did it", channel: "sidecar" })
    const { ctx, calls } = makeCtx(
      step({ kind: "agent_turn", params: { kind: "agent_turn", prompt: "go" } })
    )
    const res = await dispatchPlanStepNode(ctx, "s1", signal)
    expect(res.output).toMatchObject({ text: "did it" })
    expect(executeAgentMock).toHaveBeenCalledWith(
      "go",
      expect.objectContaining({ toolsEnabled: true, characterId: "char_1" })
    )
    expect(calls.map((c) => c.status)).toEqual(["in_progress", "completed"])
    expect(calls[1].patch).toMatchObject({ result: "did it" })
  })

  it("derives the prompt from title + description when no param prompt", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok", channel: "text" })
    const { ctx } = makeCtx(step({ title: "Build", description: "the widget" }))
    await dispatchPlanStepNode(ctx, "s1", signal)
    expect(executeAgentMock).toHaveBeenCalledWith("Build\n\nthe widget", expect.anything())
  })

  it("marks the step failed and rethrows when the turn throws", async () => {
    executeAgentMock.mockRejectedValue(new Error("boom"))
    const { ctx, calls } = makeCtx(step({ attempts: 1 }))
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toThrow("boom")
    expect(calls[1]).toMatchObject({ status: "failed", patch: { error: "boom", attempts: 2 } })
  })
})

describe("dispatchPlanStepNode — approval_gate", () => {
  it("completes when approved", async () => {
    waitForDecisionMock.mockResolvedValue({ outcome: "approve" })
    const { ctx, calls } = makeCtx(step({ kind: "approval_gate" }))
    const res = await dispatchPlanStepNode(ctx, "s1", signal)
    expect(res.output).toMatchObject({ outcome: "approve" })
    expect(waitForDecisionMock).toHaveBeenCalledWith(
      { scope: PLAN_APPROVAL_SCOPE, id: "p1:s1" },
      signal
    )
    expect(calls[1].status).toBe("completed")
  })

  it("fails (non-retryable) when rejected, carrying feedback", async () => {
    waitForDecisionMock.mockResolvedValue({ outcome: "reject", feedback: "no good" })
    const { ctx, calls } = makeCtx(step({ kind: "approval_gate" }))
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      message: expect.stringContaining("no good"),
      retryable: false,
    })
    expect(calls[1].status).toBe("failed")
  })
})

describe("dispatchPlanStepNode — sub_workflow", () => {
  it("runs the nested workflow and completes on success", async () => {
    getWorkflowMock.mockResolvedValue({ id: "wf1", name: "Nested", nodes: [], edges: [] })
    runWorkflowMock.mockResolvedValue({ runId: "x", status: "succeeded", output: { ok: 1 } })
    const { ctx, calls } = makeCtx(
      step({ kind: "sub_workflow", params: { kind: "sub_workflow", workflowId: "wf1" } })
    )
    const res = await dispatchPlanStepNode(ctx, "s1", signal)
    expect(res.output).toEqual({ ok: 1 })
    expect(calls[1].status).toBe("completed")
  })

  it("fails when the workflow id is missing from params", async () => {
    const { ctx } = makeCtx(
      step({ kind: "sub_workflow", params: { kind: "sub_workflow", workflowId: "" } })
    )
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("fails when the workflow is not found", async () => {
    getWorkflowMock.mockResolvedValue(undefined)
    const { ctx } = makeCtx(
      step({ kind: "sub_workflow", params: { kind: "sub_workflow", workflowId: "ghost" } })
    )
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      retryable: false,
    })
  })

  it("fails (retryable) when the nested run did not succeed", async () => {
    getWorkflowMock.mockResolvedValue({ id: "wf1", name: "Nested", nodes: [], edges: [] })
    runWorkflowMock.mockResolvedValue({ runId: "x", status: "failed" })
    const { ctx } = makeCtx(
      step({ kind: "sub_workflow", params: { kind: "sub_workflow", workflowId: "wf1" } })
    )
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toThrow(/status "failed"/)
  })
})

describe("dispatchPlanStepNode — deferred kinds & guards", () => {
  it("tool_call throws a non-retryable P3 marker", async () => {
    const { ctx } = makeCtx(
      step({ kind: "tool_call", params: { kind: "tool_call", toolName: "Read", input: {} } })
    )
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      message: expect.stringContaining("P3"),
      retryable: false,
    })
  })

  it("teammate_dispatch throws a non-retryable P3 marker", async () => {
    const { ctx } = makeCtx(step({ kind: "teammate_dispatch" }))
    await expect(dispatchPlanStepNode(ctx, "s1", signal)).rejects.toMatchObject({
      message: expect.stringContaining("P3"),
      retryable: false,
    })
  })

  it("throws non-retryable when the step id is absent from the plan", async () => {
    const { ctx } = makeCtx(step())
    await expect(dispatchPlanStepNode(ctx, "ghost", signal)).rejects.toMatchObject({
      retryable: false,
    })
  })
})
