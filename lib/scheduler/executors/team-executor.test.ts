import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

const hostIsTauriMock = jest.fn(() => true)
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => (hostIsTauriMock() ? "tauri" : "web"),
  isTauri: () => hostIsTauriMock(),
}))

const getMock = jest.fn()
const startMock = jest.fn()
const getRunMock = jest.fn()

jest.mock("@/lib/ai/agent/team/agent-team", () => ({
  agentTeamManager: {
    get: (...a: unknown[]) => getMock(...a),
    start: (...a: unknown[]) => startMock(...a),
  },
}))
jest.mock("@/lib/db/execution-runs", () => ({
  getExecutionRun: (...a: unknown[]) => getRunMock(...a),
}))

import { executeAgentTeamTask } from "./team-executor"

function makeTask(payload: Record<string, unknown>): ScheduledTask {
  return {
    id: "task_1",
    name: "team task",
    type: "agent-team",
    payload,
    config: { timeout: 300000 },
  } as unknown as ScheduledTask
}

const execution = { id: "exec_1" } as unknown as TaskExecution

beforeEach(() => {
  getMock.mockReset()
  startMock
    .mockReset()
    .mockResolvedValue({ started: true, runId: "run-1", executionRunId: "execution:team:run-1" })
  getRunMock.mockReset().mockResolvedValue({ status: "completed" })
})

describe("executeAgentTeamTask", () => {
  it("rejects payloads missing teamId", async () => {
    const r = await executeAgentTeamTask(makeTask({}), execution, new AbortController().signal)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/teamId/)
  })

  it("fails clearly when the team is not in the store", async () => {
    getMock.mockReturnValue(undefined)
    const r = await executeAgentTeamTask(
      makeTask({ teamId: "t1" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/team not found/)
    expect(startMock).not.toHaveBeenCalled()
  })

  it("succeeds when the team completes", async () => {
    getMock.mockReturnValueOnce({ id: "t1", status: "idle" }).mockReturnValue({
      id: "t1",
      status: "completed",
    })

    const r = await executeAgentTeamTask(
      makeTask({ teamId: "t1" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(true)
    expect(r.output).toMatchObject({ teamId: "t1", status: "completed" })
  })

  it("forwards ultracode and reports non-completed status as failure", async () => {
    getMock.mockReturnValueOnce({ id: "t1", status: "idle" }).mockReturnValue({
      id: "t1",
      status: "failed",
    })
    getRunMock.mockResolvedValue({ status: "failed" })
    const r = await executeAgentTeamTask(
      makeTask({ teamId: "t1", ultracode: true }),
      execution,
      new AbortController().signal
    )
    expect(startMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        origin: "scheduler",
        ultracode: true,
        runId: "run_team_scheduled_exec_1",
      })
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/failed/)
  })

  it("forwards cancellation and a stable run identity to the shared control facade", async () => {
    getMock.mockReturnValue({ id: "t1", status: "idle" })
    const ac = new AbortController()
    await executeAgentTeamTask(makeTask({ teamId: "t1" }), execution, ac.signal)
    expect(startMock).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        runId: "run_team_scheduled_exec_1",
        signal: ac.signal,
      })
    )
  })

  it("uses the canonical run outcome even when the team mirror is stale", async () => {
    getMock.mockReturnValue({ id: "t1", status: "completed" })
    getRunMock.mockResolvedValue({ status: "cancelled" })
    const result = await executeAgentTeamTask(
      makeTask({ teamId: "t1" }),
      execution,
      new AbortController().signal
    )
    expect(result.success).toBe(false)
    expect(result.output).toMatchObject({
      status: "cancelled",
      executionRunId: "execution:team:run-1",
    })
  })

  it("rejects when already aborted", async () => {
    getMock.mockReturnValue({ id: "t1", status: "idle" })
    const ac = new AbortController()
    ac.abort()
    const r = await executeAgentTeamTask(makeTask({ teamId: "t1" }), execution, ac.signal)
    expect(r.success).toBe(false)
    expect(startMock).not.toHaveBeenCalled()
  })
})

it("refuses on a host without the sidecar instead of starting the team", async () => {
  hostIsTauriMock.mockReturnValue(false)
  try {
    const r = await executeAgentTeamTask(
      makeTask({ teamId: "t1" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.terminalReason).toBe("unsupported-on-host")
    expect(startMock).not.toHaveBeenCalled()
  } finally {
    hostIsTauriMock.mockReturnValue(true)
  }
})
