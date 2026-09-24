/** @jest-environment jsdom */

const getExecutingPlanForSession = jest.fn()
const registerAbortController = jest.fn(() => jest.fn())
const failInSessionStep = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({
    getExecutingPlanForSession: (...args: unknown[]) => getExecutingPlanForSession(...args),
    registerAbortController: (...args: unknown[]) => registerAbortController(...(args as [])),
    failInSessionStep: (...args: unknown[]) => failInSessionStep(...args),
  }),
}))
const resolvePlanStrategy = jest.fn(() => "in_session")
jest.mock("@/lib/agent/plan/strategy", () => ({
  resolvePlanStrategy: (...args: unknown[]) => resolvePlanStrategy(...(args as [])),
}))
const handlePlanTurnComplete = jest.fn()
jest.mock("@/lib/agent/plan/turn-driver", () => ({
  handlePlanTurnComplete: (...args: unknown[]) => handlePlanTurnComplete(...args),
}))
jest.mock("@/lib/claude/hooks/lifecycle-firer", () => ({
  defaultLifecycleFirer: { fire: jest.fn() },
}))
const commitMessageDeltaMock = jest.fn().mockResolvedValue(undefined)
const persistMessagesMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/messages", () => ({
  commitMessageDelta: (...args: unknown[]) => commitMessageDeltaMock(...args),
  persistMessages: (...args: unknown[]) => persistMessagesMock(...args),
}))

import { useChatStore } from "@/stores/chat"
import { driveInSessionPlanAfterTurn, haltInSessionPlanOnTurnFailure } from "./plan-turn-settle"

const plan = {
  id: "plan-1",
  title: "Ship it",
  generationId: "gen-7",
  currentStepId: "step-2",
  steps: [
    { id: "step-1", title: "one", status: "completed" },
    { id: "step-2", title: "two", status: "in_progress" },
  ],
}

beforeEach(() => {
  jest.clearAllMocks()
  getExecutingPlanForSession.mockResolvedValue(plan)
  resolvePlanStrategy.mockReturnValue("in_session")
  useChatStore.setState({ activeSessionId: "s1", messages: [], sessions: {} })
})

describe("driveInSessionPlanAfterTurn", () => {
  it("completes the step against the plan's generation and dispatches the next one", async () => {
    handlePlanTurnComplete.mockResolvedValue({ kind: "continue", userMessage: "Step 3: go" })
    const dispatchNextStep = jest.fn()
    const dispatched = await driveInSessionPlanAfterTurn({
      sessionId: "s1",
      lastResponse: "done with two",
      isActiveSession: () => true,
      dispatchNextStep,
    })
    expect(handlePlanTurnComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "plan-1",
        lastResponse: "done with two",
        capturedGenerationId: "gen-7",
        hookContext: expect.objectContaining({ agentKind: "plan-step", sessionId: "s1" }),
      })
    )
    expect(dispatchNextStep).toHaveBeenCalledWith("Step 3: go")
    expect(dispatched).toBe(true)
  })

  it("posts the exit card instead of dispatching when the plan finished", async () => {
    handlePlanTurnComplete.mockResolvedValue({
      kind: "exit",
      status: "completed",
      reason: "all done",
    })
    const dispatchNextStep = jest.fn()
    const dispatched = await driveInSessionPlanAfterTurn({
      sessionId: "s1",
      lastResponse: "",
      isActiveSession: () => true,
      dispatchNextStep,
    })
    expect(dispatched).toBe(false)
    expect(dispatchNextStep).not.toHaveBeenCalled()
    const card = useChatStore.getState().messages.at(-1)
    expect(card).toMatchObject({ role: "system" })
    // One row appended, never a whole-transcript replace.
    expect(commitMessageDeltaMock).toHaveBeenCalledWith("s1", { upserts: [card] })
    expect(persistMessagesMock).not.toHaveBeenCalled()
  })

  it("posts the exit card into the plan's own session when another one has focus", async () => {
    handlePlanTurnComplete.mockResolvedValue({
      kind: "exit",
      status: "completed",
      reason: "all done",
    })
    const focused = [{ id: "b-1", role: "user" as const, parts: [] }]
    useChatStore.setState({ activeSessionId: "s2", messages: focused, sessions: {} })
    await driveInSessionPlanAfterTurn({
      sessionId: "s1",
      lastResponse: "",
      isActiveSession: () => false,
      dispatchNextStep: jest.fn(),
    })
    // The focused conversation is untouched, and nothing is written as s1's
    // whole transcript from it.
    expect(useChatStore.getState().messages).toEqual(focused)
    expect(persistMessagesMock).not.toHaveBeenCalled()
    expect(commitMessageDeltaMock).toHaveBeenCalledTimes(1)
    const [sessionId, delta] = commitMessageDeltaMock.mock.calls[0] as [
      string,
      { upserts: Array<{ role: string }> },
    ]
    expect(sessionId).toBe("s1")
    expect(delta.upserts).toEqual([expect.objectContaining({ role: "system" })])
    // s1's slice was not loaded here, so none is fabricated for it.
    expect(useChatStore.getState().sessions.s1).toBeUndefined()
  })

  it("does not send the next step into a session that lost focus", async () => {
    handlePlanTurnComplete.mockResolvedValue({ kind: "continue", userMessage: "next" })
    const dispatchNextStep = jest.fn()
    await driveInSessionPlanAfterTurn({
      sessionId: "s1",
      lastResponse: "",
      isActiveSession: () => false,
      dispatchNextStep,
    })
    expect(dispatchNextStep).not.toHaveBeenCalled()
  })

  it("leaves an orchestrated plan to its workflow runtime", async () => {
    resolvePlanStrategy.mockReturnValue("orchestrated")
    await driveInSessionPlanAfterTurn({
      sessionId: "s1",
      lastResponse: "",
      isActiveSession: () => true,
      dispatchNextStep: jest.fn(),
    })
    expect(handlePlanTurnComplete).not.toHaveBeenCalled()
  })

  it("never throws into the chat turn when plan bookkeeping fails", async () => {
    handlePlanTurnComplete.mockRejectedValue(new Error("db closed"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(
      driveInSessionPlanAfterTurn({
        sessionId: "s1",
        lastResponse: "",
        isActiveSession: () => true,
        dispatchNextStep: jest.fn(),
      })
    ).resolves.toBe(false)
    warn.mockRestore()
  })
})

describe("haltInSessionPlanOnTurnFailure", () => {
  it("halts the plan on its in-progress step with the cause, detail and generation", async () => {
    await haltInSessionPlanOnTurnFailure({
      sessionId: "s1",
      cause: "not_started",
      detail: "agentProcessBusy: Agent pi:s1 is already running",
    })
    expect(failInSessionStep).toHaveBeenCalledWith("plan-1", {
      stepId: "step-2",
      cause: "not_started",
      detail: "agentProcessBusy: Agent pi:s1 is already running",
      capturedGenerationId: "gen-7",
    })
  })

  it("is a no-op without an executing in-session plan", async () => {
    getExecutingPlanForSession.mockResolvedValueOnce(null)
    await haltInSessionPlanOnTurnFailure({ sessionId: "s1", cause: "turn_failed", detail: "x" })
    resolvePlanStrategy.mockReturnValueOnce("orchestrated")
    await haltInSessionPlanOnTurnFailure({ sessionId: "s1", cause: "turn_failed", detail: "x" })
    expect(failInSessionStep).not.toHaveBeenCalled()
  })
})
