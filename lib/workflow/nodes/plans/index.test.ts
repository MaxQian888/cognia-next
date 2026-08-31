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
