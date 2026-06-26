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
const teamShutdown = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    start: (...a: unknown[]) => teamStart(...a),
    shutdown: (...a: unknown[]) => teamShutdown(...a),
  },
}))
const runPlan = jest.fn()
jest.mock("@/lib/agent/plan/runtime", () => ({ getPlanRuntime: () => ({ runPlan }) }))
const createGoal = jest.fn()
const requestManualContinue = jest.fn()
const pauseGoal = jest.fn().mockResolvedValue({ id: "g_1", status: "paused" })
const resumeGoal = jest.fn().mockResolvedValue({ id: "g_1", status: "active" })
const stopGoal = jest.fn().mockResolvedValue({ id: "g_1", status: "stopped" })
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({ createGoal, requestManualContinue, pauseGoal, resumeGoal, stopGoal }),
}))

const requestCancelRun = jest.fn().mockReturnValue(true)
jest.mock("@/lib/workflow/runtime/run-cancel-registry", () => ({
  requestCancelRun: (...a: unknown[]) => requestCancelRun(...a),
}))

const workflowRunsGet = jest.fn()
const workflowRunsUpdate = jest.fn().mockResolvedValue(1)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ workflowRuns: { get: workflowRunsGet, update: workflowRunsUpdate } }),
}))

const isPiiSafeSendContent = jest.fn().mockReturnValue(true)
jest.mock("@/lib/connectors/ai-loop/safe-send-prompt", () => ({
  isPiiSafeSendContent: (...a: unknown[]) => isPiiSafeSendContent(...a),
}))
const runAndCaptureAssistantReply = jest.fn().mockResolvedValue({ text: "ok", messageId: "m1" })
jest.mock("@/lib/claude/run-and-capture", () => ({
  runAndCaptureAssistantReply: (...a: unknown[]) => runAndCaptureAssistantReply(...a),
}))
const hasNoLeakingPii = jest.fn().mockReturnValue(true)
jest.mock("@/lib/twin/ingest/redact", () => ({
  hasNoLeakingPii: (...a: unknown[]) => hasNoLeakingPii(...a),
}))
jest.mock("@/types/connectors/event", () => ({
  parseConversationKey: (key: string) => ({ platform: "slack", conversationId: key }),
}))
const enqueueOutbound = jest.fn().mockResolvedValue({ id: "oqj_1" })
jest.mock("@/lib/db/outbound-jobs", () => ({
  enqueueOutbound: (...a: unknown[]) => enqueueOutbound(...a),
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

  // ── Phase 1 targets ──────────────────────────────────────────────────────

  it.each([
    ["goal.pause", pauseGoal],
    ["goal.resume", resumeGoal],
    ["goal.stop", stopGoal],
  ] as const)("routes %s → goal runtime and accepts when the goal exists", async (target, fn) => {
    const r = await dispatchRemoteCommand(cmd({ target, args: { goalId: "g_1" } }))
    expect(fn).toHaveBeenCalledWith("g_1")
    expect(r.status).toBe("accepted")
  })

  it.each([["goal.pause"], ["goal.resume"], ["goal.stop"]] as const)(
    "rejects %s when the goal is not found",
    async (target) => {
      pauseGoal.mockResolvedValueOnce(null)
      resumeGoal.mockResolvedValueOnce(null)
      stopGoal.mockResolvedValueOnce(null)
      const r = await dispatchRemoteCommand(cmd({ target, args: { goalId: "missing" } }))
      expect(r.status).toBe("rejected")
      expect(r.detail).toContain("not found")
    }
  )

  it("routes workflow.cancel → requestCancelRun (live abort)", async () => {
    requestCancelRun.mockReturnValueOnce(true)
    const r = await dispatchRemoteCommand(
      cmd({ target: "workflow.cancel", args: { runId: "run_live" } })
    )
    expect(requestCancelRun).toHaveBeenCalledWith("run_live", expect.any(String))
    expect(workflowRunsUpdate).not.toHaveBeenCalled()
    expect(r.status).toBe("accepted")
  })

  it("workflow.cancel soft-cancels a non-terminal row when not live", async () => {
    requestCancelRun.mockReturnValueOnce(false)
    workflowRunsGet.mockResolvedValueOnce({ id: "run_x", status: "running" })
    const r = await dispatchRemoteCommand(
      cmd({ target: "workflow.cancel", args: { runId: "run_x" } })
    )
    expect(workflowRunsUpdate).toHaveBeenCalledWith(
      "run_x",
      expect.objectContaining({ status: "cancelled" })
    )
    expect(r.status).toBe("accepted")
  })

  it("workflow.cancel rejects when the run is missing or already terminal", async () => {
    requestCancelRun.mockReturnValueOnce(false)
    workflowRunsGet.mockResolvedValueOnce({ id: "run_done", status: "succeeded" })
    const r = await dispatchRemoteCommand(
      cmd({ target: "workflow.cancel", args: { runId: "run_done" } })
    )
    expect(workflowRunsUpdate).not.toHaveBeenCalled()
    expect(r.status).toBe("rejected")
  })

  it("routes team.stop → agentTeamManager.shutdown", async () => {
    const r = await dispatchRemoteCommand(cmd({ target: "team.stop", args: { teamId: "tm_1" } }))
    expect(teamShutdown).toHaveBeenCalledWith("tm_1")
    expect(r.status).toBe("accepted")
  })

  it("routes chat.send → runAndCaptureAssistantReply after PII gate", async () => {
    const r = await dispatchRemoteCommand(
      cmd({ target: "chat.send", args: { sessionId: "s1", prompt: "hello" } })
    )
    expect(isPiiSafeSendContent).toHaveBeenCalledWith("hello")
    expect(runAndCaptureAssistantReply).toHaveBeenCalledWith(
      "s1",
      "hello",
      undefined,
      expect.objectContaining({ execution: expect.objectContaining({ runId: "run_1" }) })
    )
    expect(r.status).toBe("accepted")
  })

  it("chat.send is blocked by the PII gate", async () => {
    isPiiSafeSendContent.mockReturnValueOnce(false)
    const r = await dispatchRemoteCommand(
      cmd({ target: "chat.send", args: { sessionId: "s1", prompt: "leak" } })
    )
    expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
    expect(r.status).toBe("rejected")
    expect(r.detail).toBe("pii_blocked")
  })

  it("routes connector.send → enqueueOutbound with a manual text segment", async () => {
    const r = await dispatchRemoteCommand(
      cmd({
        target: "connector.send",
        args: { adapterId: "slack:T1", conversationKey: "slack:T1:C1", text: "hi" },
        idempotencyKey: "idem-1",
      })
    )
    expect(hasNoLeakingPii).toHaveBeenCalledWith("hi")
    expect(enqueueOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "slack:T1",
        conversationKey: "slack:T1:C1",
        source: "manual",
        request: expect.objectContaining({
          segments: [{ type: "text", text: "hi" }],
          metadata: expect.objectContaining({ idempotencyKey: "idem-1" }),
        }),
      })
    )
    expect(r.status).toBe("accepted")
  })

  it("connector.send is blocked by the PII gate", async () => {
    hasNoLeakingPii.mockReturnValueOnce(false)
    const r = await dispatchRemoteCommand(
      cmd({
        target: "connector.send",
        args: { adapterId: "slack:T1", conversationKey: "slack:T1:C1", text: "leak" },
      })
    )
    expect(enqueueOutbound).not.toHaveBeenCalled()
    expect(r.status).toBe("rejected")
    expect(r.detail).toBe("pii_blocked")
  })

  it("connector.send falls back to runId when no Idempotency-Key is supplied", async () => {
    await dispatchRemoteCommand(
      cmd({
        target: "connector.send",
        args: { adapterId: "slack:T1", conversationKey: "slack:T1:C1", text: "hi" },
        runId: "run_77",
      })
    )
    expect(enqueueOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          metadata: expect.objectContaining({ idempotencyKey: "run_77" }),
        }),
      })
    )
  })

  it.each([
    ["goal.pause"],
    ["goal.resume"],
    ["goal.stop"],
    ["workflow.cancel"],
    ["team.stop"],
    ["chat.send"],
    ["connector.send"],
  ] as const)("rejects %s with missing required args", async (target) => {
    const r = await dispatchRemoteCommand(cmd({ target, args: {} }))
    expect(r.status).toBe("rejected")
  })
})
