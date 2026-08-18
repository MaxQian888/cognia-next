/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { installExecutionRunControlHandlers, registerAgentRunController } from "./control-handlers"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun } from "@/lib/db/execution-runs"
import { executeRunControlCommand } from "./run-control"

const mockCancelWorkflowRun = jest.fn(async (_runId: string) => undefined)
jest.mock("@/lib/workflow/runtime/cancel-run", () => ({
  cancelWorkflowRun: (...args: unknown[]) =>
    mockCancelWorkflowRun(...(args as Parameters<typeof mockCancelWorkflowRun>)),
}))

const mockPauseGoal = jest.fn(async (id: string) => ({ id, status: "paused" }))
const mockResumeGoal = jest.fn(async (id: string) => ({ id, status: "active" }))
const mockStopGoal = jest.fn(async (id: string) => ({ id, status: "stopped" }))
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({
    pauseGoal: mockPauseGoal,
    resumeGoal: mockResumeGoal,
    stopGoal: mockStopGoal,
  }),
}))

const mockPausePlan = jest.fn(async (id: string) => ({ id, status: "paused" }))
const mockResumePlan = jest.fn(async (id: string) => ({ id, status: "executing" }))
const mockCancelPlan = jest.fn(async (id: string) => ({ id, status: "cancelled" }))
const mockApprovePlan = jest.fn(async (id: string) => ({ id, status: "approved" }))
const mockRejectPlan = jest.fn(async (id: string) => ({ id, status: "cancelled" }))
const mockStartPlan = jest.fn(async () => ({ strategy: "in_session", status: "executing" }))
const mockRunPlan = jest.fn(async () => ({ status: "completed" }))
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({
    pausePlan: mockPausePlan,
    resumePlan: mockResumePlan,
    cancelPlan: mockCancelPlan,
    approvePlan: mockApprovePlan,
    rejectPlan: mockRejectPlan,
    startPlan: mockStartPlan,
    runPlan: mockRunPlan,
  }),
}))

describe("execution source control handlers", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    jest.clearAllMocks()
  })

  it("stops only the addressed agent run", async () => {
    const first = new AbortController()
    const second = new AbortController()
    const unregisterFirst = registerAgentRunController("run-1", first)
    const unregisterSecond = registerAgentRunController("run-2", second)
    const installed = installExecutionRunControlHandlers()

    await installed.agent({
      runId: "run-1",
      action: "stop",
      idempotencyKey: "stop-1",
      expectedRevision: 0,
      actor: {},
    })

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    unregisterFirst()
    unregisterSecond()
    installed.dispose()
  })

  it("routes agent resume through the canonical crashed-run recovery entry", async () => {
    const resumeAgentRun = jest.fn(async () => ({ resumed: true as const }))
    const installed = installExecutionRunControlHandlers({ resumeAgentRun })

    await installed.agent({
      runId: "run-recovery",
      action: "resume",
      idempotencyKey: "resume-1",
      expectedRevision: 0,
      actor: {},
    })

    expect(resumeAgentRun).toHaveBeenCalledWith("run-recovery")
    installed.dispose()
  })

  it("routes Goal and Plan lifecycle controls to their canonical runtimes", async () => {
    const installed = installExecutionRunControlHandlers()
    await createExecutionRun({
      id: "goal-run",
      kind: "goal",
      sourceId: "goal-source",
      title: "Goal",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    await createExecutionRun({
      id: "plan-run",
      kind: "plan",
      sourceId: "plan-source",
      title: "Plan",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })

    await installed.goal({
      runId: "goal-run",
      action: "pause",
      idempotencyKey: "goal-pause",
      expectedRevision: 0,
      actor: {},
    })
    await installed.goal({
      runId: "goal-run",
      action: "resume",
      idempotencyKey: "goal-resume",
      expectedRevision: 0,
      actor: {},
    })
    await installed.plan({
      runId: "plan-run",
      action: "stop",
      idempotencyKey: "plan-stop",
      expectedRevision: 0,
      actor: {},
    })

    expect(mockPauseGoal).toHaveBeenCalledWith("goal-source")
    expect(mockResumeGoal).toHaveBeenCalledWith("goal-source")
    expect(mockCancelPlan).toHaveBeenCalledWith("plan-source")
    installed.dispose()
  })

  it.each(["team", "scheduled"] as const)(
    "registers %s runs with the workflow cancellation handler",
    async (kind) => {
      const installed = installExecutionRunControlHandlers()
      await createExecutionRun({
        id: `${kind}-run`,
        kind,
        sourceId: `${kind}-source`,
        title: "Workflow",
        status: "running",
        initiator: { remoteUserId: "operator-1" },
        currentRevision: 0,
        startedAt: 1,
        updatedAt: 1,
      })

      const result = await executeRunControlCommand({
        runId: `${kind}-run`,
        action: "stop",
        idempotencyKey: `${kind}-stop`,
        expectedRevision: 0,
        actor: { remoteUserId: "operator-1" },
      })

      expect(result.accepted).toBe(true)
      expect(mockCancelWorkflowRun).toHaveBeenCalledWith(`${kind}-source`, "im_control")
      installed.dispose()
    }
  )
})

// A companion mirrors plan rows read-only, so approving from the phone has to
// travel back as a control command; a local write would be overwritten by the
// next sync pull.
describe("plan approval over run control", () => {
  // Own the reset: this block sits outside the suite-level beforeEach, so each
  // case seeds its own run id rather than colliding on a shared one.
  let seq = 0
  async function seedPlanRun(): Promise<string> {
    const id = `plan-approval-run-${(seq += 1)}`
    await createExecutionRun({
      id,
      kind: "plan",
      sourceId: "plan-source",
      title: "Plan",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    return id
  }

  const command = (runId: string, action: "approve" | "deny") => ({
    runId,
    action,
    idempotencyKey: `${runId}-${action}`,
    expectedRevision: 0,
    actor: {},
  })

  it("approves and hands an in-session plan to the chat surface", async () => {
    const installed = installExecutionRunControlHandlers()
    const runId = await seedPlanRun()
    await installed.plan(command(runId, "approve"))
    expect(mockApprovePlan).toHaveBeenCalledWith("plan-source")
    expect(mockStartPlan).toHaveBeenCalledWith("plan-source")
    // In-session plans are driven by the visible chat turns, not headlessly.
    expect(mockRunPlan).not.toHaveBeenCalled()
    installed.dispose()
  })

  it("starts an orchestrated plan headlessly on approval", async () => {
    mockStartPlan.mockResolvedValueOnce({ strategy: "orchestrated", status: "approved" })
    const installed = installExecutionRunControlHandlers()
    const runId = await seedPlanRun()
    await installed.plan(command(runId, "approve"))
    expect(mockRunPlan).toHaveBeenCalledWith("plan-source")
    installed.dispose()
  })

  it("denies through rejectPlan", async () => {
    const installed = installExecutionRunControlHandlers()
    const runId = await seedPlanRun()
    await installed.plan(command(runId, "deny"))
    expect(mockRejectPlan).toHaveBeenCalledWith("plan-source")
    expect(mockApprovePlan).not.toHaveBeenCalled()
    installed.dispose()
  })
})
