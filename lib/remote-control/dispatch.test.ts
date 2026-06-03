import { dispatchRemoteCommand } from "./dispatch"
import type { RemoteCommand } from "@/types/remote-control"

const runTaskNow = jest.fn()
jest.mock("@/stores/scheduler/scheduler-store", () => ({
  useSchedulerStore: { getState: () => ({ runTaskNow }) },
}))
const emitSchedulerEvent = jest.fn()
jest.mock("@/lib/scheduler/event-integration", () => ({
  emitSchedulerEvent: (...a: unknown[]) => emitSchedulerEvent(...a),
}))
const startWorkflowFromRemote = jest.fn().mockResolvedValue({ ok: true, runId: "run_wf" })
jest.mock("@/lib/workflow/runtime/start-from-remote", () => ({
  startWorkflowFromRemote: (...a: unknown[]) => startWorkflowFromRemote(...a),
}))
const teamStart = jest.fn()
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: { start: (...a: unknown[]) => teamStart(...a) },
}))
const runPlan = jest.fn()
jest.mock("@/lib/agent/plan/runtime", () => ({ getPlanRuntime: () => ({ runPlan }) }))
const createGoal = jest.fn()
const requestManualContinue = jest.fn()
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({ createGoal, requestManualContinue }),
}))

function cmd(over: Partial<RemoteCommand>): RemoteCommand {
  return { target: "scheduler.task.run", args: {}, runId: "run_1", ...over }
}

describe("dispatchRemoteCommand", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    startWorkflowFromRemote.mockResolvedValue({ ok: true, runId: "run_wf" })
  })

  it("routes scheduler.task.run → runTaskNow with triggerSource remote", async () => {
    const r = await dispatchRemoteCommand(
      cmd({ target: "scheduler.task.run", args: { taskId: "t1" } })
    )
    expect(runTaskNow).toHaveBeenCalledWith("t1", { triggerSource: "remote" })
    expect(r.status).toBe("accepted")
  })

  it("rejects scheduler.task.run with missing taskId", async () => {
    const r = await dispatchRemoteCommand(cmd({ target: "scheduler.task.run", args: {} }))
    expect(r.status).toBe("rejected")
    expect(runTaskNow).not.toHaveBeenCalled()
  })

  it("routes scheduler.event → emitSchedulerEvent", async () => {
    const r = await dispatchRemoteCommand(
      cmd({
        target: "scheduler.event",
        args: { eventType: "custom", data: { x: 1 }, eventSource: "ci" },
      })
    )
    expect(emitSchedulerEvent).toHaveBeenCalledWith("custom", { x: 1 }, "ci")
    expect(r.status).toBe("accepted")
  })

  it("routes workflow.run → startWorkflowFromRemote and rejects on not-found", async () => {
    const ok = await dispatchRemoteCommand(
      cmd({ target: "workflow.run", args: { workflowId: "wf_1" }, runId: "run_wf" })
    )
    expect(startWorkflowFromRemote).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "wf_1", runId: "run_wf" })
    )
    expect(ok.status).toBe("accepted")

    startWorkflowFromRemote.mockResolvedValueOnce({
      ok: false,
      reason: "workflow-not-found",
      workflowId: "wf_x",
    })
    const bad = await dispatchRemoteCommand(
      cmd({ target: "workflow.run", args: { workflowId: "wf_x" } })
    )
    expect(bad.status).toBe("rejected")
  })

  it("routes team.dispatch → agentTeamManager.start", async () => {
    const r = await dispatchRemoteCommand(
      cmd({ target: "team.dispatch", args: { teamId: "tm_1" } })
    )
    expect(teamStart).toHaveBeenCalledWith("tm_1")
    expect(r.status).toBe("accepted")
  })

  it("routes plan.run → getPlanRuntime().runPlan", async () => {
    const r = await dispatchRemoteCommand(cmd({ target: "plan.run", args: { planId: "pl_1" } }))
    expect(runPlan).toHaveBeenCalledWith("pl_1")
    expect(r.status).toBe("accepted")
  })

  it("routes goal.continue → requestManualContinue", async () => {
    const r = await dispatchRemoteCommand(cmd({ target: "goal.continue", args: { goalId: "g_1" } }))
    expect(requestManualContinue).toHaveBeenCalledWith("g_1")
    expect(r.status).toBe("accepted")
  })

  it("routes goal.create → createGoal and requires sessionId + rawObjective", async () => {
    const ok = await dispatchRemoteCommand(
      cmd({ target: "goal.create", args: { sessionId: "s1", rawObjective: "ship it" } })
    )
    expect(createGoal).toHaveBeenCalledWith({ sessionId: "s1", rawObjective: "ship it" })
    expect(ok.status).toBe("accepted")

    const bad = await dispatchRemoteCommand(
      cmd({ target: "goal.create", args: { rawObjective: "x" } })
    )
    expect(bad.status).toBe("rejected")
  })

  it.each([
    ["scheduler.event"],
    ["workflow.run"],
    ["team.dispatch"],
    ["plan.run"],
    ["goal.continue"],
    ["goal.create"],
  ])("rejects %s with missing required args", async (target) => {
    const r = await dispatchRemoteCommand(cmd({ target: target as never, args: {} }))
    expect(r.status).toBe("rejected")
  })

  it("scheduler.event defaults data and eventSource when absent", async () => {
    const r = await dispatchRemoteCommand(
      cmd({ target: "scheduler.event", args: { eventType: "x" } })
    )
    expect(emitSchedulerEvent).toHaveBeenCalledWith("x", {}, undefined)
    expect(r.status).toBe("accepted")
  })

  it("rejects with String(error) when a non-Error is thrown", async () => {
    startWorkflowFromRemote.mockRejectedValueOnce("string failure")
    const r = await dispatchRemoteCommand(
      cmd({ target: "workflow.run", args: { workflowId: "wf_1" } })
    )
    expect(r.status).toBe("rejected")
    expect(r.detail).toContain("string failure")
  })

  it("rejects an unknown target", async () => {
    const r = await dispatchRemoteCommand(cmd({ target: "nope" as never, args: {} }))
    expect(r.status).toBe("rejected")
  })

  it("rejects (does not throw) when a handler throws", async () => {
    startWorkflowFromRemote.mockRejectedValueOnce(new Error("boom"))
    const r = await dispatchRemoteCommand(
      cmd({ target: "workflow.run", args: { workflowId: "wf_1" } })
    )
    expect(r.status).toBe("rejected")
    expect(r.detail).toContain("boom")
  })
})
