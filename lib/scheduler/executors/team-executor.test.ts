import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

const getMock = jest.fn()
const startMock = jest.fn()
const abortTeamMock = jest.fn()

jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    get: (...a: unknown[]) => getMock(...a),
    start: (...a: unknown[]) => startMock(...a),
  },
}))
jest.mock("@/lib/ai/agent/agent-team-runtime", () => ({
  abortTeam: (...a: unknown[]) => abortTeamMock(...a),
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
  startMock.mockReset()
  abortTeamMock.mockReset()
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
    startMock.mockResolvedValue(undefined)
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
    startMock.mockResolvedValue(undefined)
    const r = await executeAgentTeamTask(
      makeTask({ teamId: "t1", ultracode: true }),
      execution,
      new AbortController().signal
    )
    expect(startMock).toHaveBeenCalledWith("t1", { origin: "scheduler", ultracode: true })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/failed/)
  })

  it("aborts the team when the signal fires", async () => {
    getMock.mockReturnValue({ id: "t1", status: "idle" })
    const ac = new AbortController()
    startMock.mockImplementation(async () => {
      ac.abort()
    })
    await executeAgentTeamTask(makeTask({ teamId: "t1" }), execution, ac.signal)
    expect(abortTeamMock).toHaveBeenCalledWith("t1", expect.any(Error))
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
