/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "."
import { getExecutor } from "../registry"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getPlanRunContext, unregisterPlanRunContext } from "@/lib/agent/plan/plan-run-context"

const dispatchPlanStepNode = jest.fn()
jest.mock("@/lib/agent/plan/step-dispatch", () => ({
  dispatchPlanStepNode: (...args: unknown[]) => dispatchPlanStepNode(...args),
}))
jest.mock("@/lib/agent/plan/step-workspace", () => ({
  resolvePlanExecutionRoot: jest.fn(async () => ({ root: "/tmp/plan" })),
}))
const mockBuildRendererLlmClient = jest.fn((_args: unknown) => null)
jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: (args: unknown) => mockBuildRendererLlmClient(args),
}))

describe("plan-nodes registration", () => {
  it.each([
    ["action.plan.approve", 1],
    ["action.plan.cancel", 1],
    ["action.plan.create", 1],
    ["action.plan.delete", 1],
    ["action.plan.events", 1],
    ["action.plan.get", 1],
    ["action.plan.list", 1],
    ["action.plan.pause", 1],
    ["action.plan.refine", 1],
    ["action.plan.reject", 1],
    ["action.plan.resume", 1],
    ["action.plan.run", 1],
    ["action.plan.setStepStatus", 1],
    ["action.plan.step.dispatch", 1],
    ["action.plan.updateDraft", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})

/**
 * `/plan to-workflow` writes a durable workflow of `action.plan.step.dispatch`
 * nodes and tells the user it is theirs to edit and re-run. Pressing Run always
 * failed with `no PlanRunContext registered`, because only `runPlan` ever
 * registered one.
 */
describe("action.plan.step.dispatch outside the plan runtime", () => {
  const runId = "run_standalone"

  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
    dispatchPlanStepNode.mockReset()
    dispatchPlanStepNode.mockResolvedValue({ output: { ok: true } })
    unregisterPlanRunContext(runId)
  })

  function run(params: Record<string, unknown>) {
    const executor = getExecutor("action.plan.step.dispatch" as never, 1)!
    return executor.execute({
      runId,
      params,
      signal: undefined,
    } as never)
  }

  it("builds a run context from the node's planId and dispatches the step", async () => {
    await getDb().agentPlans.put({
      id: "plan_1",
      sessionId: "ses_1",
      title: "T",
      status: "executing",
      steps: [{ id: "s1", title: "Step", kind: "agent_turn", status: "pending" }],
      totalSteps: 1,
      completedSteps: 0,
      createdAt: 1,
      updatedAt: 1,
    } as never)

    await run({ planId: "plan_1", stepId: "s1" })

    expect(dispatchPlanStepNode).toHaveBeenCalledTimes(1)
    const ctx = dispatchPlanStepNode.mock.calls[0]![0] as { planId: string; executionRoot?: string }
    expect(ctx.planId).toBe("plan_1")
    expect(ctx.executionRoot).toBe("/tmp/plan")
    // Registered for the run, so sibling step nodes reuse it.
    expect(getPlanRunContext(runId)?.planId).toBe("plan_1")
  })

  it("fails with the plan id in the message when the plan is gone", async () => {
    await expect(run({ planId: "plan_missing", stepId: "s1" })).rejects.toThrow(/plan_missing/)
  })

  it("still requires both ids", async () => {
    await expect(run({ planId: "plan_1" })).rejects.toThrow(/'planId' and 'stepId'/)
  })
})

describe("action.plan.reject", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
  })

  function reject(params: Record<string, unknown>) {
    const executor = getExecutor("action.plan.reject" as never, 1)!
    return executor.execute({ runId: "r", params, signal: undefined } as never) as Promise<{
      output: { planId: string; changed: boolean; rejected: boolean; plan: { status: string } }
    }>
  }

  async function seed(status: string) {
    await getDb().agentPlans.put({
      id: "plan_r",
      sessionId: "ses_1",
      title: "T",
      source: "manual",
      executionMode: "auto",
      status,
      steps: [],
      totalSteps: 0,
      completedSteps: 0,
      config: {},
      refinementCount: 0,
      generationId: "g",
      createdAt: 1,
      updatedAt: 1,
    } as never)
  }

  it("lands the terminal rejected status and says so", async () => {
    await seed("awaiting_approval")
    const { output } = await reject({ planId: "plan_r", feedback: "not now" })
    expect(output.rejected).toBe(true)
    expect(output.plan.status).toBe("rejected")
    expect((await getDb().agentPlans.get("plan_r"))?.status).toBe("rejected")
  })

  it("reports rejected=false for a plan that already started", async () => {
    await seed("executing")
    const { output } = await reject({ planId: "plan_r" })
    expect(output.rejected).toBe(false)
    expect(output.plan.status).toBe("executing")
  })
})

describe("action.plan.refine ledger attribution", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
    mockBuildRendererLlmClient.mockClear()
  })

  async function seedPlan(sessionProjectId: string | undefined) {
    await getDb().sessions.put({
      id: "ses_ledger",
      title: "S",
      ...(sessionProjectId ? { projectId: sessionProjectId } : {}),
      createdAt: new Date(1),
      updatedAt: new Date(1),
    } as never)
    await getDb().agentPlans.put({
      id: "plan_l",
      sessionId: "ses_ledger",
      title: "T",
      source: "manual",
      executionMode: "auto",
      status: "draft",
      steps: [],
      totalSteps: 0,
      completedSteps: 0,
      config: {},
      refinementCount: 0,
      generationId: "g",
      createdAt: 1,
      updatedAt: 1,
    } as never)
  }

  function refine(projectId?: string) {
    const executor = getExecutor("action.plan.refine" as never, 1)!
    return executor.execute({
      runId: "r",
      stepId: "step_refine",
      ...(projectId ? { projectId } : {}),
      params: { planId: "plan_l" },
      signal: undefined,
    } as never)
  }

  it("books the planner call on agentsWorkflows in the plan's conversation workspace", async () => {
    await seedPlan("ws-conversation")
    await expect(refine("ws-workflow")).rejects.toThrow(/planner model/)
    expect(mockBuildRendererLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({
        featureId: "plan-refine",
        ledgerSurface: "agentsWorkflows",
        workspaceId: "ws-conversation",
      })
    )
  })

  it("falls back to the workflow's workspace when the conversation names none", async () => {
    await seedPlan(undefined)
    await expect(refine("ws-workflow")).rejects.toThrow(/planner model/)
    expect(mockBuildRendererLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-workflow" })
    )
  })
})
