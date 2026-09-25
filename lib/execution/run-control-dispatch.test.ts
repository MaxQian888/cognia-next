/** @jest-environment jsdom */

import { dispatchRunControl, type RunControlDispatch } from "./run-control-dispatch"
import { LOCAL_CONSOLE_ACTOR_ID } from "@/lib/execution/local-operator"
import { HostConsentRequiredError, issueHostAdminLease } from "@/lib/tauri/admin-lease"
import type { ExecutionRun, RunControlAction } from "@/types/execution/run"

jest.mock("@/lib/tauri/admin-lease", () => ({
  ...jest.requireActual("@/lib/tauri/admin-lease"),
  issueHostAdminLease: jest.fn(),
}))
const getExecutionRun = jest.fn()
jest.mock("@/lib/db/execution-runs", () => ({
  getExecutionRun: (...args: unknown[]) => getExecutionRun(...args),
}))
const executeRunControlCommand = jest.fn()
jest.mock("@/lib/execution/run-control", () => ({
  executeRunControlCommand: (...args: unknown[]) => executeRunControlCommand(...args),
}))
let remoteHostActive = false
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => remoteHostActive,
}))
const transportCall = jest.fn()
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => transportCall(...args) },
}))

function storedRun(allowedActions: RunControlAction[], pendingInterruptId?: string): ExecutionRun {
  return {
    id: "run-1",
    kind: "delegation",
    sourceId: "d-1",
    title: "Delegation",
    status: "waiting",
    currentRevision: 4,
    startedAt: 1,
    updatedAt: 2,
    latestSnapshot: {
      runId: "run-1",
      kind: "delegation",
      title: "Delegation",
      status: "waiting",
      revision: 4,
      startedAt: 1,
      updatedAt: 2,
      progress: { completed: 0, total: 0, trustworthy: false },
      activeSteps: [],
      recentSteps: [],
      pendingSteps: [],
      pendingStepCount: 0,
      elapsedMs: 1,
      artifacts: [],
      allowedActions,
      ...(pendingInterruptId ? { pendingInterrupt: { id: pendingInterruptId } as never } : {}),
    },
  } as ExecutionRun
}

const press = (over: Partial<RunControlDispatch> = {}): RunControlDispatch => ({
  runId: "run-1",
  action: "approve",
  surface: "island",
  hostProfile: "desktop",
  ...over,
})

beforeEach(() => {
  remoteHostActive = false
  getExecutionRun.mockReset()
  executeRunControlCommand.mockReset().mockResolvedValue({ accepted: true })
  transportCall.mockReset()
})

describe("dispatchRunControl", () => {
  it("decides the approval the surface named, keyed by surface and fresh revision", async () => {
    getExecutionRun.mockResolvedValue(storedRun(["approve", "deny", "stop"], "opaque-1a2b"))
    await expect(
      dispatchRunControl(press({ interruptId: "action-review:long-id" }))
    ).resolves.toEqual({ accepted: true })
    expect(executeRunControlCommand).toHaveBeenCalledWith(
      {
        runId: "run-1",
        action: "approve",
        idempotencyKey: "island:run-1:approve:4",
        expectedRevision: 4,
        actor: { platformIdentityId: LOCAL_CONSOLE_ACTOR_ID },
        // The real row id, not the hashed display id in the snapshot.
        interruptId: "action-review:long-id",
      },
      { operatorIds: [LOCAL_CONSOLE_ACTOR_ID] }
    )
  })

  it("falls back to the snapshot's pending approval when the surface has no id", async () => {
    getExecutionRun.mockResolvedValue(storedRun(["approve", "deny"], "i-1"))
    await dispatchRunControl(press({ action: "deny" }))
    expect(executeRunControlCommand.mock.calls[0][0]).toMatchObject({ interruptId: "i-1" })
  })

  it("never attaches an approval to a non-review action", async () => {
    getExecutionRun.mockResolvedValue(storedRun(["stop"], "i-1"))
    await dispatchRunControl(press({ action: "stop", interruptId: "i-1" }))
    expect(executeRunControlCommand.mock.calls[0][0]).not.toHaveProperty("interruptId")
  })

  it("refuses what the run no longer offers, and a run that is gone", async () => {
    getExecutionRun.mockResolvedValue(storedRun(["stop"]))
    await expect(dispatchRunControl(press())).resolves.toEqual({
      accepted: false,
      reason: "action_unavailable",
    })
    getExecutionRun.mockResolvedValue(undefined)
    await expect(dispatchRunControl(press())).resolves.toEqual({
      accepted: false,
      reason: "run_not_found",
    })
    expect(executeRunControlCommand).not.toHaveBeenCalled()
  })

  it("refuses a reviewed run that is not the one being decided", async () => {
    await expect(
      dispatchRunControl(press({ reviewedRun: { ...storedRun(["approve"]), id: "other" } }))
    ).resolves.toEqual({ accepted: false, reason: "invalid_command" })
  })

  it("keys each steer by its own sequence so two corrections are two commands", async () => {
    getExecutionRun.mockResolvedValue(storedRun(["steer"]))
    await dispatchRunControl(press({ action: "steer", steerMessage: "go", steerSequence: 3 }))
    expect(executeRunControlCommand.mock.calls[0][0]).toMatchObject({
      idempotencyKey: "island:run-1:steer:3",
      steerMessage: "go",
    })
  })

  it("sends the command to an active remote host with a fresh lease", async () => {
    remoteHostActive = true
    getExecutionRun.mockResolvedValue(storedRun(["stop"]))
    ;(issueHostAdminLease as jest.Mock).mockResolvedValue({ token: "lease" })
    transportCall.mockResolvedValue({ accepted: false, reason: "revision_conflict" })
    await expect(dispatchRunControl(press({ action: "stop" }))).resolves.toEqual({
      accepted: false,
      reason: "revision_conflict",
    })
    expect(transportCall).toHaveBeenCalledWith(
      "execution_run_control",
      expect.objectContaining({ adminLease: "lease", action: "stop" })
    )
    expect(executeRunControlCommand).not.toHaveBeenCalled()
  })

  it("reports consent and transport failures as their own reasons", async () => {
    remoteHostActive = true
    getExecutionRun.mockResolvedValue(storedRun(["stop"]))
    ;(issueHostAdminLease as jest.Mock).mockRejectedValue(
      new HostConsentRequiredError("consent", "ABC")
    )
    await expect(dispatchRunControl(press({ action: "stop" }))).resolves.toEqual({
      accepted: false,
      reason: "host_consent_required",
      consentCode: "ABC",
    })
    remoteHostActive = false
    getExecutionRun.mockRejectedValue(new Error("db closed"))
    await expect(dispatchRunControl(press())).resolves.toEqual({
      accepted: false,
      reason: "control_failed",
    })
  })
})
