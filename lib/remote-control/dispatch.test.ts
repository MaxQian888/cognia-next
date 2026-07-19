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
const teamStart = jest.fn().mockResolvedValue(undefined)
const teamShutdown = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    start: (...a: unknown[]) => teamStart(...a),
    shutdown: (...a: unknown[]) => teamShutdown(...a),
  },
}))
const runPlan = jest.fn().mockResolvedValue({ status: "completed" })
jest.mock("@/lib/agent/plan/runtime", () => ({ getPlanRuntime: () => ({ runPlan }) }))
const createGoal = jest.fn().mockResolvedValue({ id: "g_1", status: "active" })
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
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: (...a: unknown[]) => hasNoLeakingPii(...a),
}))
jest.mock("@/types/connectors/event", () => ({
  parseConversationKey: (key: string) => ({ platform: "slack", conversationId: key }),
}))
const enqueueOutbound = jest.fn().mockResolvedValue({ id: "oqj_1" })
jest.mock("@/lib/db/outbound-jobs", () => ({
  enqueueOutbound: (...a: unknown[]) => enqueueOutbound(...a),
}))
const runHeadlessExec = jest
  .fn()
  .mockResolvedValue({ ok: true, exitCode: 0, output: "", durationMs: 1, timedOut: false })
jest.mock("@/lib/terminal/headless-exec", () => ({
  runHeadlessExec: (...a: unknown[]) => runHeadlessExec(...a),
}))
const enablePlugin = jest.fn().mockResolvedValue(undefined)
const disablePlugin = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ enablePlugin, disablePlugin }),
}))
const setRemoteRunCorrelation = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/remote-control-run-status", () => ({
  setRemoteRunCorrelation: (...a: unknown[]) => setRemoteRunCorrelation(...a),
}))

// Renderer-side ACL guard reads the inbound denylist from this store.
let disabledTargets: string[] = []
jest.mock("@/stores/remote-control/store", () => ({
  useRemoteControlStore: {
    getState: () => ({ config: { inbound: { disabledTargets } } }),
  },
}))

function cmd(over: Partial<RemoteCommand>): RemoteCommand {
  return { target: "scheduler.task.run", args: {}, runId: "run_1", ...over }
}

describe("dispatchRemoteCommand", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    disabledTargets = []
    startWorkflowFromRemote.mockResolvedValue({ ok: true, runId: "run_wf" })
    teamStart.mockResolvedValue(undefined)
    runPlan.mockResolvedValue({ status: "completed" })
    createGoal.mockResolvedValue({ id: "g_1", status: "active" })
    runHeadlessExec.mockResolvedValue({
      ok: true,
      exitCode: 0,
      output: "",
      durationMs: 1,
      timedOut: false,
    })
    enablePlugin.mockResolvedValue(undefined)
    disablePlugin.mockResolvedValue(undefined)
  })

  it("routes scheduler.task.run → runTaskNow with triggerSource remote", async () => {
    const r = await dispatchRemoteCommand(
      cmd({ target: "scheduler.task.run", args: { taskId: "t1" } })
    )
    expect(runTaskNow).toHaveBeenCalledWith("t1", { triggerSource: "remote" })
    expect(r.status).toBe("accepted")
  })

  it("rejects a target on the inbound denylist without running its handler", async () => {
    disabledTargets = ["plugin.disable"]
    const r = await dispatchRemoteCommand(
      cmd({ target: "plugin.disable", args: { pluginId: "p1" } })
    )
    expect(r.status).toBe("rejected")
    expect(r.detail).toBe("target_disabled")
    expect(disablePlugin).not.toHaveBeenCalled()
  })

  it("dispatches normally when the denylist excludes the target", async () => {
    disabledTargets = ["terminal.exec"]
    const r = await dispatchRemoteCommand(
      cmd({ target: "scheduler.task.run", args: { taskId: "t1" } })
    )
    expect(r.status).toBe("accepted")
    expect(runTaskNow).toHaveBeenCalledWith("t1", { triggerSource: "remote" })
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
    expect(teamStart).toHaveBeenCalledWith("tm_1", { origin: "remote" })
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
    expect(createGoal).toHaveBeenCalledWith({
      sessionId: "s1",
      rawObjective: "ship it",
      origin: "remote",
    })
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
    ["terminal.exec"],
    ["plugin.enable"],
    ["plugin.disable"],
  ] as const)("rejects %s with missing required args", async (target) => {
    const r = await dispatchRemoteCommand(cmd({ target, args: {} }))
    expect(r.status).toBe("rejected")
  })

  // ── Round-2 targets (terminal / plugin) + terminal-status closure ──────────

  it("routes terminal.exec → runHeadlessExec and settles succeeded on exit 0", async () => {
    const r = await dispatchRemoteCommand(
      cmd({
        target: "terminal.exec",
        args: { command: "git status", cwd: "/repo", shell: "pwsh", timeoutMs: 30000 },
      })
    )
    expect(runHeadlessExec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "git status",
        cwd: "/repo",
        shell: "pwsh",
        timeoutMs: 30000,
        runId: "run_1",
        source: "workflow",
      })
    )
    expect(r.status).toBe("accepted")
    await expect(r.settle).resolves.toEqual({ status: "succeeded", detail: "exit 0" })
  })

  it("terminal.exec settles failed on a non-zero exit, a blocked run, and a timeout", async () => {
    runHeadlessExec.mockResolvedValueOnce({ ok: true, exitCode: 2, output: "", timedOut: false })
    const nonZero = await dispatchRemoteCommand(
      cmd({ target: "terminal.exec", args: { command: "x" } })
    )
    await expect(nonZero.settle).resolves.toEqual({ status: "failed", detail: "exit 2" })

    runHeadlessExec.mockResolvedValueOnce({ ok: false, reason: "classifier denied" })
    const blocked = await dispatchRemoteCommand(
      cmd({ target: "terminal.exec", args: { command: "x" } })
    )
    await expect(blocked.settle).resolves.toEqual({ status: "failed", detail: "classifier denied" })

    runHeadlessExec.mockResolvedValueOnce({ ok: true, exitCode: null, output: "", timedOut: true })
    const timedOut = await dispatchRemoteCommand(
      cmd({ target: "terminal.exec", args: { command: "x" } })
    )
    await expect(timedOut.settle).resolves.toEqual({ status: "failed", detail: "timed out" })
  })

  it("routes plugin.enable / plugin.disable and settles succeeded", async () => {
    const en = await dispatchRemoteCommand(
      cmd({ target: "plugin.enable", args: { pluginId: "p1" } })
    )
    expect(enablePlugin).toHaveBeenCalledWith("p1", "remote-control")
    expect(en.status).toBe("accepted")
    await expect(en.settle).resolves.toEqual({
      status: "succeeded",
      detail: expect.stringContaining("p1"),
    })

    const dis = await dispatchRemoteCommand(
      cmd({ target: "plugin.disable", args: { pluginId: "p1" } })
    )
    expect(disablePlugin).toHaveBeenCalledWith("p1", "remote-control")
    expect(dis.status).toBe("accepted")
    await expect(dis.settle).resolves.toEqual({
      status: "succeeded",
      detail: expect.stringContaining("p1"),
    })
  })

  it("plugin.enable settle reports failed when the manager throws", async () => {
    enablePlugin.mockRejectedValueOnce(new Error("not installed"))
    const r = await dispatchRemoteCommand(
      cmd({ target: "plugin.enable", args: { pluginId: "p1" } })
    )
    expect(r.status).toBe("accepted")
    await expect(r.settle).resolves.toEqual({ status: "failed", detail: "not installed" })
  })

  it("team.dispatch settle succeeds when the run finishes and fails when it throws", async () => {
    const ok = await dispatchRemoteCommand(
      cmd({ target: "team.dispatch", args: { teamId: "tm_1" } })
    )
    await expect(ok.settle).resolves.toEqual({
      status: "succeeded",
      detail: expect.stringContaining("tm_1"),
    })

    teamStart.mockRejectedValueOnce(new Error("team boom"))
    const bad = await dispatchRemoteCommand(
      cmd({ target: "team.dispatch", args: { teamId: "tm_2" } })
    )
    expect(bad.status).toBe("accepted")
    await expect(bad.settle).resolves.toEqual({ status: "failed", detail: "team boom" })
  })

  it("plan.run settle maps the terminal plan status (completed/failed/null)", async () => {
    const done = await dispatchRemoteCommand(cmd({ target: "plan.run", args: { planId: "pl_1" } }))
    await expect(done.settle).resolves.toEqual({
      status: "succeeded",
      detail: expect.stringContaining("completed"),
    })

    runPlan.mockResolvedValueOnce({ status: "failed" })
    const failed = await dispatchRemoteCommand(
      cmd({ target: "plan.run", args: { planId: "pl_2" } })
    )
    await expect(failed.settle).resolves.toEqual({
      status: "failed",
      detail: expect.stringContaining("failed"),
    })

    runPlan.mockResolvedValueOnce(null)
    const notRunnable = await dispatchRemoteCommand(
      cmd({ target: "plan.run", args: { planId: "pl_3" } })
    )
    await expect(notRunnable.settle).resolves.toEqual({
      status: "rejected",
      detail: "plan not runnable",
    })
  })

  it.each([
    ["cancelled", "cancelled"],
    ["executing", "running"],
    ["paused", "running"],
    ["approved", "running"], // any non-terminal status maps to running (default arm)
  ] as const)("plan.run settle maps plan status %s → %s", async (planStatus, expected) => {
    runPlan.mockResolvedValueOnce({ status: planStatus })
    const r = await dispatchRemoteCommand(cmd({ target: "plan.run", args: { planId: "pl_x" } }))
    await expect(r.settle).resolves.toEqual(expect.objectContaining({ status: expected }))
  })

  it("chat.send settle succeeds at end of turn", async () => {
    const r = await dispatchRemoteCommand(
      cmd({ target: "chat.send", args: { sessionId: "s1", prompt: "hello" } })
    )
    expect(r.status).toBe("accepted")
    await expect(r.settle).resolves.toEqual({
      status: "succeeded",
      detail: expect.stringContaining("s1"),
    })
  })

  it("goal.create stamps the goalId correlation and settles running", async () => {
    createGoal.mockResolvedValueOnce({ id: "g_99", status: "active" })
    const r = await dispatchRemoteCommand(
      cmd({ target: "goal.create", args: { sessionId: "s1", rawObjective: "x" }, runId: "run_g" })
    )
    expect(r.status).toBe("accepted")
    await expect(r.settle).resolves.toEqual({
      status: "running",
      detail: expect.stringContaining("g_99"),
    })
    expect(setRemoteRunCorrelation).toHaveBeenCalledWith("run_g", "g_99")
  })
})
