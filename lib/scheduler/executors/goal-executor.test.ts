import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

const isTauriMock = jest.fn(() => true)
const createSessionMock = jest.fn()
const getSessionMock = jest.fn()
const createGoalMock = jest.fn()
const runGoalLoopMock = jest.fn()

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => (isTauriMock() ? "tauri" : "web"),
  isTauri: () => isTauriMock(),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(async () => null) }))
jest.mock("@/lib/db/sessions", () => ({
  createSession: (...a: unknown[]) => createSessionMock(...a),
  getSession: (...a: unknown[]) => getSessionMock(...a),
}))
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({ createGoal: (...a: unknown[]) => createGoalMock(...a) }),
}))
jest.mock("./goal-headless-runner", () => ({
  runGoalLoopHeadless: (...a: unknown[]) => runGoalLoopMock(...a),
}))

import { executeGoalTask } from "./goal-executor"

function makeTask(payload: Record<string, unknown>): ScheduledTask {
  return {
    id: "task_1",
    name: "goal task",
    type: "goal",
    payload,
    config: { timeout: 300000 },
  } as unknown as ScheduledTask
}

const execution = { id: "exec_1" } as unknown as TaskExecution

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  createSessionMock.mockReset().mockResolvedValue({ id: "new_session" })
  getSessionMock.mockReset()
  createGoalMock.mockReset().mockResolvedValue({ id: "goal_1" })
  runGoalLoopMock.mockReset().mockResolvedValue({ status: "completed", turns: 3 })
})

describe("executeGoalTask", () => {
  it("requires a host with the sidecar capability", async () => {
    isTauriMock.mockReturnValue(false)
    const r = await executeGoalTask(
      makeTask({ objective: "x" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/sidecar capability/)
    expect(r.terminalReason).toBe("unsupported-on-host")
  })

  it("rejects payloads missing objective", async () => {
    const r = await executeGoalTask(makeTask({}), execution, new AbortController().signal)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/objective/)
  })

  it("returns early when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await executeGoalTask(makeTask({ objective: "x" }), execution, controller.signal)
    expect(r).toEqual({ success: false, error: "Goal task aborted before start" })
    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it("continues with no app defaults when getSettings throws", async () => {
    const settings = jest.requireMock("@/lib/db/settings") as { getSettings: jest.Mock }
    settings.getSettings.mockRejectedValueOnce(new Error("db locked"))
    const r = await executeGoalTask(
      makeTask({ objective: "ship it", characterId: "c1" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(true)
  })

  it("creates a fresh session + goal and drives the loop to completion", async () => {
    const r = await executeGoalTask(
      makeTask({ objective: "ship it", characterId: "c1" }),
      execution,
      new AbortController().signal
    )
    expect(createSessionMock).toHaveBeenCalled()
    expect(createGoalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "new_session",
        rawObjective: "ship it",
        characterId: "c1",
      })
    )
    expect(runGoalLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "new_session", goalId: "goal_1" })
    )
    expect(r.success).toBe(true)
    expect(r.output).toMatchObject({ goalId: "goal_1", status: "completed", turns: 3 })
  })

  it("reuses a supplied session when present", async () => {
    getSessionMock.mockResolvedValue({ id: "existing" })
    await executeGoalTask(
      makeTask({ objective: "x", sessionId: "existing" }),
      execution,
      new AbortController().signal
    )
    expect(createSessionMock).not.toHaveBeenCalled()
    expect(createGoalMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "existing" }))
  })

  it("fails when the supplied session is missing", async () => {
    getSessionMock.mockResolvedValue(undefined)
    const r = await executeGoalTask(
      makeTask({ objective: "x", sessionId: "ghost" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Session not found/)
  })

  it("maps a non-completed terminal status to failure", async () => {
    runGoalLoopMock.mockResolvedValue({ status: "budget_limited", turns: 5, error: "over budget" })
    const r = await executeGoalTask(
      makeTask({ objective: "x" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/over budget/)
  })

  it("surfaces a createGoal error", async () => {
    createGoalMock.mockRejectedValue(new Error("im blocked"))
    const r = await executeGoalTask(
      makeTask({ objective: "x" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe("im blocked")
  })
})
