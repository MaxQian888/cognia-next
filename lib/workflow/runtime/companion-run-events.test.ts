import {
  RUN_STATUS_CHANNEL,
  RUN_TERMINAL_PUSH_CHANNEL,
  SYNC_INVALIDATE_CHANNEL,
  notifyCompanionsOfRunState,
  type CompanionRunEventDeps,
} from "./companion-run-events"
import type { WorkflowRunRow } from "@/types/workflow/visual"

function makeDeps(run?: Partial<WorkflowRunRow>) {
  const emit = jest.fn(async (_event: string, _payload: unknown) => undefined)
  const deps: CompanionRunEventDeps = {
    emit,
    getRun: jest.fn(async () => run as WorkflowRunRow | undefined),
    isTauriFn: () => true,
  }
  return { emit, deps }
}

const base = { runId: "run_1", workflowId: "wf_1" } as const

describe("notifyCompanionsOfRunState", () => {
  it("is a no-op outside Tauri", async () => {
    const { emit, deps } = makeDeps()
    await notifyCompanionsOfRunState(
      { ...base, status: "failed" },
      { ...deps, isTauriFn: () => false }
    )
    expect(emit).not.toHaveBeenCalled()
  })

  it("emits only the live status frame for non-terminal transitions", async () => {
    const { emit, deps } = makeDeps()
    await notifyCompanionsOfRunState({ ...base, status: "running", lastStepId: "n_2" }, deps)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(RUN_STATUS_CHANNEL, {
      runId: "run_1",
      workflowId: "wf_1",
      status: "running",
      lastStepId: "n_2",
    })
  })

  it("emits sync invalidate + push on failure (push regardless of device)", async () => {
    const { emit, deps } = makeDeps({})
    await notifyCompanionsOfRunState({ ...base, status: "failed" }, deps)
    expect(emit).toHaveBeenCalledWith(SYNC_INVALIDATE_CHANNEL, { table: "workflowRuns" })
    expect(emit).toHaveBeenCalledWith(RUN_TERMINAL_PUSH_CHANNEL, {
      runId: "run_1",
      workflowId: "wf_1",
      status: "failed",
    })
  })

  it("pushes a success only when a paired device triggered the run", async () => {
    const withDevice = makeDeps({ triggeredBy: { source: "api", deviceId: "dev-7" } })
    await notifyCompanionsOfRunState({ ...base, status: "succeeded" }, withDevice.deps)
    expect(withDevice.emit).toHaveBeenCalledWith(RUN_TERMINAL_PUSH_CHANNEL, {
      runId: "run_1",
      workflowId: "wf_1",
      status: "succeeded",
      deviceId: "dev-7",
    })

    const noDevice = makeDeps({ triggeredBy: { source: "ui" } })
    await notifyCompanionsOfRunState({ ...base, status: "succeeded" }, noDevice.deps)
    const pushed = noDevice.emit.mock.calls.filter(([ch]) => ch === RUN_TERMINAL_PUSH_CHANNEL)
    expect(pushed).toHaveLength(0)
    // Sync invalidate still fires for every terminal run.
    expect(noDevice.emit).toHaveBeenCalledWith(SYNC_INVALIDATE_CHANNEL, { table: "workflowRuns" })
  })

  it("payloads never carry names or error text (ids + status only)", async () => {
    const { emit, deps } = makeDeps({
      triggeredBy: { source: "api", deviceId: "dev-7" },
      error: { message: "secret stack" },
    } as Partial<WorkflowRunRow>)
    await notifyCompanionsOfRunState({ ...base, status: "failed" }, deps)
    for (const [, payload] of emit.mock.calls) {
      expect(JSON.stringify(payload)).not.toContain("secret stack")
    }
  })

  it("swallows emitter failures (best-effort)", async () => {
    const { deps } = makeDeps()
    ;(deps.emit as jest.Mock).mockRejectedValue(new Error("bus down"))
    await expect(notifyCompanionsOfRunState({ ...base, status: "failed" }, deps)).resolves.toBe(
      undefined
    )
  })
})
