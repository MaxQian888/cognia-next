import type { RunGoalLoopInput } from "./goal-headless-runner"
import type { Project } from "@/types"

const getGoalMock = jest.fn()
const getSessionMock = jest.fn()
const resolveSendOptionsMock = jest.fn()
const runCaptureMock = jest.fn()
const buildJudgeMock = jest.fn()
const handleTurnCompleteMock = jest.fn()
const getAllProjectsMock = jest.fn()

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
// The owning workspace is read from Dexie (no project store headlessly).
jest.mock("@/lib/db/projects", () => ({
  getAllProjects: () => getAllProjectsMock(),
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
  getAllProjectsMock.mockReset().mockResolvedValue([])
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
    // Each turn registers a "goal" execution leg with the broker.
    expect(runCaptureMock.mock.calls[0][3]).toMatchObject({ execution: { kind: "goal" } })
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

  it("delivers each turn's captured text via onTurn", async () => {
    getGoalMock.mockResolvedValue(activeGoal)
    runCaptureMock.mockResolvedValueOnce({ text: "r1" }).mockResolvedValueOnce({ text: "r2" })
    handleTurnCompleteMock
      .mockResolvedValueOnce({ kind: "continue", userMessage: "keep going" })
      .mockResolvedValueOnce({
        kind: "exit",
        resultingStatus: "completed",
        exit: "judge_done",
        reason: "done",
      })
    const onTurn = jest.fn()
    await runGoalLoopHeadless(input({ onTurn }))
    expect(onTurn).toHaveBeenNthCalledWith(1, "r1", 1, activeGoal)
    expect(onTurn).toHaveBeenNthCalledWith(2, "r2", 2, activeGoal)
  })

  it("pacing: manualContinue holds — the driver exits active after one turn", async () => {
    const manualGoal = { ...activeGoal, config: { maxTurns: 20, manualContinue: true } }
    getGoalMock.mockResolvedValue(manualGoal)
    runCaptureMock.mockResolvedValue({ text: "r1" })
    handleTurnCompleteMock.mockResolvedValue({ kind: "continue", userMessage: "more" })

    const r = await runGoalLoopHeadless(input({ pacing: { enabled: true } }))
    expect(r.status).toBe("active")
    expect(r.error).toBe("held")
    expect(r.turns).toBe(1)
    expect(runCaptureMock).toHaveBeenCalledTimes(1)
  })

  it("pacing: defers by the min interval, then continues", async () => {
    const pacedGoal = { ...activeGoal, config: { maxTurns: 20, continuationIntervalMs: 10_000 } }
    getGoalMock.mockResolvedValue(pacedGoal)
    runCaptureMock.mockResolvedValueOnce({ text: "r1" }).mockResolvedValueOnce({ text: "r2" })
    handleTurnCompleteMock
      .mockResolvedValueOnce({ kind: "continue", userMessage: "more" })
      .mockResolvedValueOnce({
        kind: "exit",
        resultingStatus: "completed",
        exit: "judge_done",
        reason: "done",
      })
    // Turn 1 continues at t=1000 (baseline). The gate then defers until 11000;
    // the sleep advances the clock past the window so the re-check sends.
    let t = 1000
    const now = jest.fn(() => t)
    const sleep = jest.fn().mockImplementation(async () => {
      t = 11_000
    })

    const r = await runGoalLoopHeadless(input({ pacing: { enabled: true, now, sleep } }))
    expect(r.status).toBe("completed")
    expect(r.turns).toBe(2)
    expect(sleep).toHaveBeenCalledWith(10_000)
  })

  it("pacing: falls back to real Date.now + setTimeout when no clock is injected", async () => {
    // A tiny (20 ms) interval so the default timer path is exercised for real
    // without a slow test — one short defer between the two turns.
    const pacedGoal = { ...activeGoal, config: { maxTurns: 20, continuationIntervalMs: 20 } }
    getGoalMock.mockResolvedValue(pacedGoal)
    runCaptureMock.mockResolvedValueOnce({ text: "r1" }).mockResolvedValueOnce({ text: "r2" })
    handleTurnCompleteMock
      .mockResolvedValueOnce({ kind: "continue", userMessage: "more" })
      .mockResolvedValueOnce({
        kind: "exit",
        resultingStatus: "completed",
        exit: "judge_done",
        reason: "done",
      })
    const r = await runGoalLoopHeadless(input({ pacing: { enabled: true } }))
    expect(r.status).toBe("completed")
    expect(r.turns).toBe(2)
  })
})

describe("runGoalLoopHeadless — owning workspace (ADR-0144)", () => {
  function makeProject(id: string): Project {
    return { id, name: id, rootPath: `/repos/${id}` } as unknown as Project
  }

  /** The `activeProject` each resolveSendOptions call received, in order. */
  function resolvedWorkspaces(): Array<Project | null | undefined> {
    return resolveSendOptionsMock.mock.calls.map(
      (call) => (call[0] as { activeProject?: Project | null }).activeProject
    )
  }

  /** One turn that ends the goal, so each case drives exactly one resolution. */
  function oneTurn() {
    getGoalMock.mockResolvedValue(activeGoal)
    runCaptureMock.mockResolvedValue({ text: "r1" })
    handleTurnCompleteMock.mockResolvedValue({
      kind: "exit",
      resultingStatus: "completed",
      exit: "judge_done",
      reason: "done",
    })
  }

  it("resolves every turn against the session's workspace, read once", async () => {
    const owning = makeProject("proj-owning")
    getSessionMock.mockResolvedValue({ id: "s1", projectId: "proj-owning" })
    getAllProjectsMock.mockResolvedValue([makeProject("proj-ui"), owning])
    getGoalMock.mockResolvedValue(activeGoal)
    runCaptureMock.mockResolvedValueOnce({ text: "r1" }).mockResolvedValueOnce({ text: "r2" })
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
    expect(resolvedWorkspaces()).toEqual([owning, owning])
    // The goal section still rides along with the workspace.
    expect(resolveSendOptionsMock.mock.calls[0][0]).toMatchObject({ activeGoal })
    expect(getAllProjectsMock).toHaveBeenCalledTimes(1)
  })

  it("resolves a bound session through its binding's workspace", async () => {
    const bound = makeProject("proj-bound")
    getSessionMock.mockResolvedValue({
      id: "s1",
      executionContext: { projectId: "proj-bound", location: "local", projectRoot: "/repos/b" },
    })
    getAllProjectsMock.mockResolvedValue([makeProject("proj-ui"), bound])
    oneTurn()

    await runGoalLoopHeadless(input())
    expect(resolvedWorkspaces()).toEqual([bound])
  })

  it("prefers the session's own projectId over its binding's, like resolveSessionWorkspace", async () => {
    const own = makeProject("proj-session")
    getSessionMock.mockResolvedValue({
      id: "s1",
      projectId: "proj-session",
      executionContext: { projectId: "proj-bound", location: "local", projectRoot: "/repos/b" },
    })
    getAllProjectsMock.mockResolvedValue([makeProject("proj-bound"), own])
    oneTurn()

    await runGoalLoopHeadless(input())
    expect(resolvedWorkspaces()).toEqual([own])
  })

  it("runs with no workspace when the session's workspace was deleted", async () => {
    getSessionMock.mockResolvedValue({ id: "s1", projectId: "proj-gone" })
    getAllProjectsMock.mockResolvedValue([makeProject("proj-ui")])
    oneTurn()

    await runGoalLoopHeadless(input())
    expect(resolvedWorkspaces()).toEqual([null])
  })

  it("does not read the workspaces for a session that names none", async () => {
    oneTurn()

    await runGoalLoopHeadless(input())
    expect(resolvedWorkspaces()).toEqual([null])
    expect(getAllProjectsMock).not.toHaveBeenCalled()
  })

  it("still drives the goal, with no workspace, when the workspace read fails", async () => {
    getSessionMock.mockResolvedValue({ id: "s1", projectId: "proj-owning" })
    getAllProjectsMock.mockRejectedValue(new Error("db closed"))
    oneTurn()

    const r = await runGoalLoopHeadless(input())
    expect(r.status).toBe("completed")
    expect(resolvedWorkspaces()).toEqual([null])
    expect(runCaptureMock).toHaveBeenCalledTimes(1)
  })

  it('resolves with no workspace when the caller passes workspace: "none"', async () => {
    getSessionMock.mockResolvedValue({ id: "s1", projectId: "proj-owning" })
    getAllProjectsMock.mockResolvedValue([makeProject("proj-owning")])
    oneTurn()

    await runGoalLoopHeadless(input({ workspace: "none" }))
    expect(resolvedWorkspaces()).toEqual([null])
    expect(getAllProjectsMock).not.toHaveBeenCalled()
  })

  it("sends the resolved options untouched, so confinement roots match the cwd", async () => {
    // Unlike a scheduled chat run, nothing on the goal path moves the cwd or
    // additional directories after resolution (no task lease, no payload
    // union). The roots build-options derived from them must reach the turn.
    const resolved = {
      model: "m",
      cwd: "/repos/proj-owning",
      additionalDirectories: ["/extra"],
      confinement: { enabled: true, roots: ["/repos/proj-owning", "/extra"] },
    }
    getSessionMock.mockResolvedValue({ id: "s1", projectId: "proj-owning" })
    getAllProjectsMock.mockResolvedValue([makeProject("proj-owning")])
    resolveSendOptionsMock.mockResolvedValue(resolved)
    oneTurn()

    await runGoalLoopHeadless(input())
    expect(runCaptureMock.mock.calls[0][2]).toBe(resolved)
  })
})

describe("runGoalLoopHeadless — unattended permissions", () => {
  /** A capture that asks for each tool in turn, then replies `text`. */
  function captureAsking(tools: string[], text: string) {
    return async (
      _sessionId: string,
      _prompt: unknown,
      _options: unknown,
      cap: { onPermissionRequest?: (req: unknown) => unknown }
    ) => {
      for (const [i, toolName] of tools.entries()) {
        const decision = await cap.onPermissionRequest?.({
          type: "permission_request",
          sessionId: "s1",
          requestId: `req-${toolName}-${i}`,
          toolUseID: `tu-${i}`,
          toolName,
          input: {},
        })
        decisions.push(decision)
      }
      return { text }
    }
  }
  let decisions: unknown[] = []

  beforeEach(() => {
    decisions = []
    getGoalMock.mockResolvedValue(activeGoal)
  })

  it("denies a permission request at once and tells the model why", async () => {
    runCaptureMock.mockImplementation(captureAsking(["Edit"], "Edit needs approval."))
    handleTurnCompleteMock.mockResolvedValue({
      kind: "exit",
      exit: "needs_approval",
      resultingStatus: "paused",
      reason: "no approver attached for: Edit",
    })

    await runGoalLoopHeadless(input())
    expect(decisions).toEqual([
      { decision: "deny", message: expect.stringContaining('Tool "Edit" needs a human approval') },
    ])
    expect((decisions[0] as { message: string }).message).toContain("this goal turn")
  })

  it("hands the turn's denied tools to the turn driver and reports the pause", async () => {
    runCaptureMock.mockImplementation(captureAsking(["Edit", "Bash"], "Blocked on approval."))
    handleTurnCompleteMock.mockResolvedValue({
      kind: "exit",
      exit: "needs_approval",
      resultingStatus: "paused",
      reason: "no approver attached for: Edit, Bash",
    })

    const r = await runGoalLoopHeadless(input())
    expect(handleTurnCompleteMock.mock.calls[0][0].needsApproval).toEqual(["Edit", "Bash"])
    expect(r).toMatchObject({
      status: "paused",
      turns: 1,
      exit: "needs_approval",
      error: "needs approval: Edit, Bash",
      lastResponse: "Blocked on approval.",
    })
    expect(r.needsApproval).toEqual([
      expect.objectContaining({ requestId: "req-Edit-0", toolName: "Edit" }),
      expect.objectContaining({ requestId: "req-Bash-1", toolName: "Bash" }),
    ])
  })

  it("passes only the current turn's denials, and reports every denial of the run", async () => {
    // Turn 1 is denied Edit but arms the promise check (the driver continues);
    // turn 2 asks for nothing and completes.
    runCaptureMock
      .mockImplementationOnce(captureAsking(["Edit"], "done, Edit not needed"))
      .mockImplementationOnce(captureAsking([], "<promise>SHIPPED</promise>"))
    handleTurnCompleteMock
      .mockResolvedValueOnce({ kind: "continue", userMessage: "emit the promise" })
      .mockResolvedValueOnce({
        kind: "exit",
        exit: "judge_done",
        resultingStatus: "completed",
        reason: "completion promise confirmed",
      })

    const r = await runGoalLoopHeadless(input())
    expect(handleTurnCompleteMock.mock.calls[0][0].needsApproval).toEqual(["Edit"])
    expect(handleTurnCompleteMock.mock.calls[1][0].needsApproval).toEqual([])
    expect(r.status).toBe("completed")
    expect(r.exit).toBe("judge_done")
    // A completed goal is not an approval failure, but the record stays.
    expect(r.error).toBeUndefined()
    expect(r.needsApproval).toEqual([expect.objectContaining({ toolName: "Edit" })])
  })

  it("keeps the denials when the turn fails after one", async () => {
    runCaptureMock.mockImplementation(async (...args: unknown[]) => {
      await captureAsking(["Write"], "")(...(args as Parameters<ReturnType<typeof captureAsking>>))
      throw new Error("sidecar crashed")
    })

    const r = await runGoalLoopHeadless(input())
    expect(r.error).toBe("sidecar crashed")
    expect(r.needsApproval).toEqual([expect.objectContaining({ toolName: "Write" })])
    expect(handleTurnCompleteMock).not.toHaveBeenCalled()
  })

  it("wires the responder into an injected sender too (the connector path)", async () => {
    const sendTurn = jest.fn(captureAsking(["Bash"], "r1"))
    handleTurnCompleteMock.mockResolvedValue({
      kind: "exit",
      exit: "needs_approval",
      resultingStatus: "paused",
      reason: "no approver attached for: Bash",
    })

    const r = await runGoalLoopHeadless(input({ sendTurn: sendTurn as never }))
    expect(sendTurn.mock.calls[0][3]).toEqual(
      expect.objectContaining({ onPermissionRequest: expect.any(Function) })
    )
    expect(r.needsApproval).toEqual([expect.objectContaining({ toolName: "Bash" })])
  })

  it("adds nothing to the result when no tool asked", async () => {
    runCaptureMock.mockResolvedValue({ text: "r1" })
    handleTurnCompleteMock.mockResolvedValue({
      kind: "exit",
      exit: "judge_done",
      resultingStatus: "completed",
      reason: "done",
    })

    const r = await runGoalLoopHeadless(input())
    expect(handleTurnCompleteMock.mock.calls[0][0].needsApproval).toEqual([])
    expect(r).toEqual({ status: "completed", turns: 1, lastResponse: "r1", exit: "judge_done" })
  })
})
