import { act, renderHook } from "@testing-library/react"

import { useRunControlActions } from "./use-agent-run-actions"
import { LOCAL_CONSOLE_ACTOR_ID } from "@/lib/execution/local-operator"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"
import type { ExecutionRun, RunControlAction } from "@/types/execution/run"

const getExecutionRun = jest.fn()
jest.mock("@/lib/db/execution-runs", () => ({
  getExecutionRun: (...args: unknown[]) => getExecutionRun(...args),
}))

const executeRunControlCommand = jest.fn()
jest.mock("@/lib/execution/run-control", () => ({
  executeRunControlCommand: (...args: unknown[]) => executeRunControlCommand(...args),
}))

let hostProfile = "desktop"
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => hostProfile,
}))
const transportCall = jest.fn()
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => transportCall(...args) },
}))

function row(over: Partial<UnifiedExecutionRow> = {}): UnifiedExecutionRow {
  return {
    rowId: "journal:run-1",
    source: "journal",
    nativeId: "run-1",
    kind: "agent-turn",
    label: "Chat run",
    status: "running",
    startedAt: 1,
    runId: "run-1",
    cancellable: false,
    allowedActions: ["stop", "steer", "open_details"],
    ...over,
  }
}

function storedRun(
  over: Partial<ExecutionRun> = {},
  allowedActions: RunControlAction[] = ["stop", "steer", "open_details"]
): ExecutionRun {
  return {
    id: "run-1",
    kind: "agent-turn",
    sourceId: "turn-1",
    title: "Chat run",
    status: "running",
    currentRevision: 7,
    startedAt: 1,
    updatedAt: 2,
    latestSnapshot: {
      runId: "run-1",
      kind: "agent-turn",
      title: "Chat run",
      status: "running",
      revision: 7,
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
    },
    ...over,
  }
}

beforeEach(() => {
  getExecutionRun.mockReset()
  executeRunControlCommand.mockReset()
  executeRunControlCommand.mockResolvedValue({ accepted: true, currentRevision: 8 })
})

describe("useRunControlActions on a companion", () => {
  beforeEach(() => {
    hostProfile = "mobile-companion"
    getExecutionRun.mockReset()
    executeRunControlCommand.mockReset()
    transportCall.mockReset()
  })
  afterEach(() => {
    hostProfile = "desktop"
  })

  it("submits the same revision-checked command to the desktop host instead of acting locally", async () => {
    getExecutionRun.mockResolvedValue(storedRun({}, ["pause", "stop", "open_details"]))
    transportCall.mockResolvedValue({ accepted: true, currentRevision: 8 })
    const { result } = renderHook(() => useRunControlActions())
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.dispatch(
        row({ allowedActions: ["pause", "stop", "open_details"] }),
        "pause"
      )
    })
    expect(outcome).toEqual({ accepted: true })
    expect(executeRunControlCommand).not.toHaveBeenCalled()
    expect(transportCall).toHaveBeenCalledWith(
      "execution_run_control",
      expect.objectContaining({
        runId: "run-1",
        action: "pause",
        expectedRevision: 7,
        idempotencyKey: "cockpit:run-1:pause:7",
      })
    )
    const payload = transportCall.mock.calls[0]?.[1] as Record<string, unknown>
    expect(payload.actor).toBeUndefined()
  })

  it("reads a host refusal as the gate's own refusal", async () => {
    getExecutionRun.mockResolvedValue(storedRun({}, ["stop", "open_details"]))
    transportCall.mockResolvedValue({
      accepted: false,
      reason: "revision_conflict",
      currentRevision: 9,
    })
    const { result } = renderHook(() => useRunControlActions())
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.dispatch(
        row({ allowedActions: ["stop", "open_details"] }),
        "stop"
      )
    })
    expect(outcome).toEqual({ accepted: false, reason: "revision_conflict" })
  })
})

describe("useRunControlActions", () => {
  it("offers exactly the verbs the projection allows", () => {
    const { result } = renderHook(() => useRunControlActions())
    const r = row()
    expect(result.current.can(r, "stop")).toBe(true)
    expect(result.current.can(r, "steer")).toBe(true)
    // Not in `allowedActions` — the reducer refuses to pause an agent turn.
    expect(result.current.can(r, "pause")).toBe(false)
  })

  it("offers nothing on a row with no journal behind it", async () => {
    const { result } = renderHook(() => useRunControlActions())
    const legacy = row({ rowId: "legacy:goal:g1", source: "legacy", allowedActions: undefined })
    expect(result.current.can(legacy, "stop")).toBe(false)

    const outcome = await act(() => result.current.dispatch(legacy, "stop"))
    expect(outcome).toEqual({ accepted: false, reason: "not_controllable" })
    expect(executeRunControlCommand).not.toHaveBeenCalled()
  })

  it("dispatches with the FRESH revision, not the one rendered on the row", async () => {
    getExecutionRun.mockResolvedValue(storedRun({ currentRevision: 42 }))
    const { result } = renderHook(() => useRunControlActions())

    await act(() => result.current.dispatch(row(), "stop"))

    expect(executeRunControlCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        action: "stop",
        expectedRevision: 42,
        idempotencyKey: "cockpit:run-1:stop:42",
        actor: { platformIdentityId: LOCAL_CONSOLE_ACTOR_ID },
      }),
      { operatorIds: [LOCAL_CONSOLE_ACTOR_ID] }
    )
  })

  it("grants the local operator id so a run with no initiator is not forbidden", async () => {
    getExecutionRun.mockResolvedValue(storedRun())
    const { result } = renderHook(() => useRunControlActions())

    await act(() => result.current.dispatch(row(), "stop"))

    const [, options] = executeRunControlCommand.mock.calls[0]
    expect(options.operatorIds).toContain(LOCAL_CONSOLE_ACTOR_ID)
  })

  it("refuses an action the run stopped offering between paint and click", async () => {
    // Rendered while running; by the time the click lands the run has settled.
    getExecutionRun.mockResolvedValue(storedRun({ status: "completed" }, ["open_details"]))
    const { result } = renderHook(() => useRunControlActions())

    const outcome = await act(() => result.current.dispatch(row(), "stop"))

    expect(outcome).toEqual({ accepted: false, reason: "action_unavailable" })
    expect(executeRunControlCommand).not.toHaveBeenCalled()
  })

  it("reports a vanished run rather than dispatching into nothing", async () => {
    getExecutionRun.mockResolvedValue(undefined)
    const { result } = renderHook(() => useRunControlActions())

    const outcome = await act(() => result.current.dispatch(row(), "stop"))

    expect(outcome).toEqual({ accepted: false, reason: "run_not_found" })
    expect(executeRunControlCommand).not.toHaveBeenCalled()
  })

  it("surfaces revision_conflict instead of swallowing it", async () => {
    getExecutionRun.mockResolvedValue(storedRun())
    executeRunControlCommand.mockResolvedValue({
      accepted: false,
      reason: "revision_conflict",
      currentRevision: 9,
    })
    const { result } = renderHook(() => useRunControlActions())

    const outcome = await act(() => result.current.dispatch(row(), "stop"))

    expect(outcome).toEqual({ accepted: false, reason: "revision_conflict" })
  })

  it("surfaces steer_degraded WITH its reason — the message is still the caller's", async () => {
    getExecutionRun.mockResolvedValue(storedRun())
    executeRunControlCommand.mockResolvedValue({
      accepted: false,
      reason: "steer_degraded",
      degradedReason: "no_active_run",
    })
    const { result } = renderHook(() => useRunControlActions())

    const outcome = await act(() =>
      result.current.dispatch(row(), "steer", { steerMessage: "focus on the tests" })
    )

    expect(outcome).toEqual({
      accepted: false,
      reason: "steer_degraded",
      degradedReason: "no_active_run",
    })
  })

  it("passes the steer message on the command and never in a journalled field", async () => {
    getExecutionRun.mockResolvedValue(storedRun())
    const { result } = renderHook(() => useRunControlActions())

    await act(() => result.current.dispatch(row(), "steer", { steerMessage: "use pnpm" }))

    const [command] = executeRunControlCommand.mock.calls[0]
    expect(command.steerMessage).toBe("use pnpm")
    expect(JSON.stringify({ ...command, steerMessage: undefined })).not.toContain("use pnpm")
  })

  /**
   * Two corrections in a row are two instructions. Keying a steer on the
   * revision would collapse them into one and silently drop the second.
   */
  it("gives each steer its own idempotency key", async () => {
    getExecutionRun.mockResolvedValue(storedRun())
    const { result } = renderHook(() => useRunControlActions())

    await act(() => result.current.dispatch(row(), "steer", { steerMessage: "first" }))
    await act(() => result.current.dispatch(row(), "steer", { steerMessage: "second" }))

    const keys = executeRunControlCommand.mock.calls.map(([c]) => c.idempotencyKey)
    expect(new Set(keys).size).toBe(2)
  })

  /** A double-click on Stop IS one press, and must be answered as a duplicate. */
  it("keys a repeated non-steer press identically so the gate can dedupe it", async () => {
    getExecutionRun.mockResolvedValue(storedRun())
    const { result } = renderHook(() => useRunControlActions())

    await act(() => result.current.dispatch(row(), "stop"))
    await act(() => result.current.dispatch(row(), "stop"))

    const keys = executeRunControlCommand.mock.calls.map(([c]) => c.idempotencyKey)
    expect(keys[0]).toBe(keys[1])
  })

  it("carries the pending interrupt id on approve", async () => {
    getExecutionRun.mockResolvedValue(
      storedRun(
        {
          latestSnapshot: {
            ...storedRun().latestSnapshot!,
            allowedActions: ["approve", "deny", "open_details"],
            pendingInterrupt: { id: "interrupt-3", title: "Run tests?" },
          },
        },
        ["approve", "deny", "open_details"]
      )
    )
    const { result } = renderHook(() => useRunControlActions())

    await act(() =>
      result.current.dispatch(row({ allowedActions: ["approve", "deny"] }), "approve")
    )

    expect(executeRunControlCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: "approve", interruptId: "interrupt-3" }),
      expect.anything()
    )
  })

  it("returns the replacement run a retry minted", async () => {
    getExecutionRun.mockResolvedValue(storedRun({ status: "failed" }, ["retry", "open_details"]))
    executeRunControlCommand.mockResolvedValue({
      accepted: true,
      currentRevision: 7,
      retryRunId: "run-2",
    })
    const { result } = renderHook(() => useRunControlActions())

    const outcome = await act(() =>
      result.current.dispatch(row({ allowedActions: ["retry"] }), "retry")
    )

    expect(outcome).toEqual({ accepted: true, retryRunId: "run-2" })
  })

  it("clears the pending row once the command settles", async () => {
    getExecutionRun.mockResolvedValue(storedRun())
    const { result } = renderHook(() => useRunControlActions())

    expect(result.current.pendingRowId).toBeNull()
    await act(() => result.current.dispatch(row(), "stop"))
    expect(result.current.pendingRowId).toBeNull()
  })
})
