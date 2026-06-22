import type { RunGoalLoopInput } from "./goal-headless-runner"

const getGoalMock = jest.fn()
const getSessionMock = jest.fn()
const resolveSendOptionsMock = jest.fn()
const runCaptureMock = jest.fn()
const buildJudgeMock = jest.fn()
const handleTurnCompleteMock = jest.fn()

jest.mock("@/lib/db/goals", () => ({ getGoal: (...a: unknown[]) => getGoalMock(...a) }))
jest.mock("@/lib/db/sessions", () => ({ getSession: (...a: unknown[]) => getSessionMock(...a) }))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: (...a: unknown[]) => resolveSendOptionsMock(...a),
}))
jest.mock("@/lib/claude/run-and-capture", () => {
  // Define the error class inside the factory — jest hoists mock factories
  // above module-scope declarations, so an outer class would be uninitialized.
  class FakeRunAndCaptureError extends Error {
    code: string
    constructor(message: string, code: string) {
      super(message)
      this.code = code
    }
  }
  return {
    runAndCaptureAssistantReply: (...a: unknown[]) => runCaptureMock(...a),
    RunAndCaptureError: FakeRunAndCaptureError,
  }
})
jest.mock("@/lib/goal/judge-client", () => ({
  buildGoalJudgeClient: (...a: unknown[]) => buildJudgeMock(...a),
}))
jest.mock("@/lib/goal/turn-driver", () => ({
  handleTurnComplete: (...a: unknown[]) => handleTurnCompleteMock(...a),
}))

import { runGoalLoopHeadless } from "./goal-headless-runner"
import { RunAndCaptureError } from "@/lib/claude/run-and-capture"

const activeGoal = {
  id: "g1",
  status: "active",
  generationId: "gen1",
  safeObjective: "do the thing",
  config: { maxTurns: 20 },
}

function input(overrides: Partial<RunGoalLoopInput> = {}): RunGoalLoopInput {
  return {
    sessionId: "s1",
    goalId: "g1",
    appSettings: null,
    signal: new AbortController().signal,
    ...overrides,
  }
}

beforeEach(() => {
  getGoalMock.mockReset()
  getSessionMock.mockReset()
  resolveSendOptionsMock.mockReset()
  runCaptureMock.mockReset()
  buildJudgeMock.mockReset()
  handleTurnCompleteMock.mockReset()
  getSessionMock.mockResolvedValue({ id: "s1" })
  buildJudgeMock.mockReturnValue({ id: "judge" })
  resolveSendOptionsMock.mockResolvedValue({ model: "m" })
})

describe("runGoalLoopHeadless", () => {
  it("returns stopped when the session is missing", async () => {
    getSessionMock.mockResolvedValue(undefined)
    const r = await runGoalLoopHeadless(input())
    expect(r.status).toBe("stopped")
    expect(r.error).toMatch(/Session not found/)
  })

  it("returns paused when no judge client is available", async () => {
    buildJudgeMock.mockReturnValue(null)
    const r = await runGoalLoopHeadless(input())
    expect(r.status).toBe("paused")
    expect(r.error).toMatch(/judge client/)
  })

  it("drives continue → exit and returns the terminal status", async () => {
    getGoalMock.mockResolvedValue(activeGoal)
    runCaptureMock
      .mockResolvedValueOnce({ text: "r1", usage: { inputTokens: 3, outputTokens: 4 } })
      .mockResolvedValueOnce({ text: "r2" })
    handleTurnCompleteMock
      .mockResolvedValueOnce({ kind: "continue", userMessage: "keep going" })
      .mockResolvedValueOnce({
        kind: "exit",
        resultingStatus: "completed",
        exit: "judge_done",
        reason: "done",
      })

    const r = await runGoalLoopHeadless(input())
    expect(r.status).toBe("completed")
    expect(r.turns).toBe(2)
    expect(r.lastResponse).toBe("r2")
    // First turn sends the redacted objective; second sends the continuation.
    expect(runCaptureMock.mock.calls[0][1]).toBe("do the thing")
    expect(runCaptureMock.mock.calls[1][1]).toBe("keep going")
    // tokensDelta from usage is forwarded to the driver.
    expect(handleTurnCompleteMock.mock.calls[0][0].tokensDelta).toBe(7)
    expect(handleTurnCompleteMock.mock.calls[0][0].usage).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    })
  })

  it("stops driving when the goal is already terminal", async () => {
    getGoalMock
      .mockResolvedValueOnce(activeGoal) // initial hard-cap read
      .mockResolvedValueOnce({ ...activeGoal, status: "completed" }) // loop top
    const r = await runGoalLoopHeadless(input())
    expect(r.status).toBe("completed")
    expect(runCaptureMock).not.toHaveBeenCalled()
  })

  it("returns paused when a turn aborts", async () => {
    getGoalMock.mockResolvedValue(activeGoal)
    runCaptureMock.mockRejectedValue(new RunAndCaptureError("aborted", "aborted"))
    const r = await runGoalLoopHeadless(input())
    expect(r.status).toBe("paused")
    expect(r.error).toMatch(/aborted/)
  })

  it("returns early when the signal is already aborted", async () => {
    getGoalMock.mockResolvedValue(activeGoal)
    const ac = new AbortController()
    ac.abort()
    const r = await runGoalLoopHeadless(input({ signal: ac.signal }))
    expect(r.status).toBe("paused")
    expect(runCaptureMock).not.toHaveBeenCalled()
  })
})
