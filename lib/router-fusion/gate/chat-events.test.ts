jest.mock("@/lib/claude/ipc", () => ({ callReserveDecision: jest.fn(async () => undefined) }))

import type { ClaudeEvent } from "@cognia/agent-config-types"

import { __resetBreakerForTesting, getBreakerSnapshot } from "./breaker"
import {
  cancelRouterFusionTurn,
  finishAllRouterFusionTurns,
  finishRouterFusionTurn,
  handleRouterFusionSidecarFrame,
  isRouterFusionSidecarFrame,
  observeRouterFusionTurnMessage,
  routerFusionOutcomeOfResult,
  routerFusionOutcomeOfSessionEnd,
  routerFusionTurnActive,
  type RouterFusionSidecarFrame,
} from "./chat-events"
import { RouterFusionInfrastructureError } from "./faults"
import type { RouterFusionHost } from "./load-engine"
import {
  __resetFusionTurnsForTesting,
  fusionTurnBypassOf,
  fusionTurnOf,
  markFusionTurn,
} from "./turn-registry"

const reserve: RouterFusionSidecarFrame = {
  type: "call_reserve_request",
  sessionId: "s1",
  runId: "run-1",
  requestId: "req-1",
  kind: "call",
  logicalStepId: "leg:0",
  deploymentId: "openai::gpt-5",
}

const failingLoad = async (): Promise<RouterFusionHost> => {
  throw new RouterFusionInfrastructureError("import_failed", "chunk")
}

describe("router-fusion chat events", () => {
  afterEach(() => {
    __resetFusionTurnsForTesting()
    __resetBreakerForTesting()
  })

  it("recognises only the three ledger frames", () => {
    expect(isRouterFusionSidecarFrame(reserve)).toBe(true)
    expect(
      isRouterFusionSidecarFrame({ type: "ledger_bypassed", sessionId: "s1", reason: "x" })
    ).toBe(true)
    expect(isRouterFusionSidecarFrame({ type: "ready" } as ClaudeEvent)).toBe(false)
  })

  it("hands a frame to the host", async () => {
    const handleRouterFusionSidecarEvent = jest.fn().mockResolvedValue(undefined)
    const decide = jest.fn()
    await handleRouterFusionSidecarFrame(reserve, {
      loadHost: async () => ({ handleRouterFusionSidecarEvent }) as unknown as RouterFusionHost,
      decide,
    })
    expect(handleRouterFusionSidecarEvent).toHaveBeenCalledWith(reserve, { decide })
  })

  it("[ACC:ISO-01] still answers a reservation with bypass when Router + Fusion cannot load", async () => {
    markFusionTurn("s1", "run-1")
    const decide = jest.fn(async () => undefined)
    await handleRouterFusionSidecarFrame(reserve, { loadHost: failingLoad, decide })
    expect(decide).toHaveBeenCalledWith("s1", "req-1", {
      decision: "bypass",
      code: "import_failed",
    })
    expect(fusionTurnBypassOf("s1")).toEqual({ code: "import_failed", justTripped: false })
    expect(getBreakerSnapshot("chat").consecutiveFaults).toBe(1)
  })

  it("answers bypass when the host throws while handling a reservation", async () => {
    const decide = jest.fn(async () => undefined)
    await handleRouterFusionSidecarFrame(reserve, {
      loadHost: async () =>
        ({
          handleRouterFusionSidecarEvent: async () => {
            throw Object.assign(new Error("closed"), { name: "DatabaseClosedError" })
          },
        }) as unknown as RouterFusionHost,
      decide,
    })
    expect(decide).toHaveBeenCalledWith("s1", "req-1", {
      decision: "bypass",
      code: "db_unavailable",
    })
  })

  it("observes and finishes only a session with a ledgered turn", async () => {
    const observeRouterFusionSdkMessage = jest.fn().mockResolvedValue(undefined)
    const finishRouterFusionChatTurn = jest.fn().mockResolvedValue({ runId: "run-1" })
    const cancelRouterFusionChatTurn = jest.fn().mockResolvedValue(undefined)
    const loadHost = jest.fn(
      async () =>
        ({
          observeRouterFusionSdkMessage,
          finishRouterFusionChatTurn,
          cancelRouterFusionChatTurn,
        }) as unknown as RouterFusionHost
    )
    expect(routerFusionTurnActive("s1")).toBe(false)
    expect(
      observeRouterFusionTurnMessage("s1", { type: "assistant" }, { loadHost })
    ).toBeUndefined()
    expect(await finishRouterFusionTurn("s1", { status: "succeeded" }, { loadHost })).toBeNull()
    await cancelRouterFusionTurn("s1", { loadHost })
    expect(loadHost).not.toHaveBeenCalled()

    markFusionTurn("s1", "run-1")
    expect(routerFusionTurnActive("s1")).toBe(true)
    // Token deltas never reach the envelope; the handler's hot path stays synchronous.
    expect(
      observeRouterFusionTurnMessage("s1", { type: "stream_event" }, { loadHost })
    ).toBeUndefined()
    await observeRouterFusionTurnMessage("s1", { type: "assistant" }, { loadHost })
    await cancelRouterFusionTurn("s1", { loadHost })
    await expect(
      finishRouterFusionTurn("s1", { status: "cancelled" }, { loadHost })
    ).resolves.toEqual({
      runId: "run-1",
    })
    expect(observeRouterFusionSdkMessage).toHaveBeenCalledTimes(1)
    expect(observeRouterFusionSdkMessage).toHaveBeenCalledWith("s1", { type: "assistant" })
    expect(cancelRouterFusionChatTurn).toHaveBeenCalledWith("s1")
    expect(finishRouterFusionChatTurn).toHaveBeenCalledWith("s1", { status: "cancelled" })
  })

  it("never throws out of finishing a turn, and forgets it", async () => {
    markFusionTurn("s1", "run-1")
    await expect(
      finishRouterFusionTurn("s1", { status: "failed" }, { loadHost: failingLoad })
    ).resolves.toBeNull()
    expect(fusionTurnOf("s1")).toBeUndefined()
  })

  it("seals every ledgered turn when the host exits, and does nothing when none is ledgered", async () => {
    const finishRouterFusionChatTurn = jest.fn().mockResolvedValue({ runId: "run" })
    const loadHost = jest.fn(
      async () => ({ finishRouterFusionChatTurn }) as unknown as RouterFusionHost
    )
    const error = { code: "SIDECAR_EXITED", message: "exited" }
    expect(finishAllRouterFusionTurns(error, { loadHost })).toBeUndefined()
    markFusionTurn("s1", "run-1")
    markFusionTurn("s2", "run-2")
    await finishAllRouterFusionTurns(error, { loadHost })
    expect(finishRouterFusionChatTurn).toHaveBeenCalledWith("s1", { status: "failed", error })
    expect(finishRouterFusionChatTurn).toHaveBeenCalledWith("s2", { status: "failed", error })
  })

  it("never rejects out of observing a message when the host is gone", async () => {
    markFusionTurn("s1", "run-1")
    await expect(
      observeRouterFusionTurnMessage("s1", { type: "result" }, { loadHost: failingLoad })
    ).resolves.toBeUndefined()
    expect(fusionTurnBypassOf("s1")).toEqual({ code: "import_failed", justTripped: false })
  })
})

describe("router-fusion turn outcomes", () => {
  it("reads the outcome of an SDK result", () => {
    expect(routerFusionOutcomeOfResult({ type: "result", subtype: "success" })).toEqual({
      status: "succeeded",
    })
    expect(routerFusionOutcomeOfResult({ type: "result", subtype: "error_max_turns" })).toEqual({
      status: "failed",
      error: { code: "ERROR_MAX_TURNS", message: "The turn ended with error_max_turns." },
    })
    expect(routerFusionOutcomeOfResult({ subtype: "success", is_error: true }).status).toBe(
      "failed"
    )
  })

  it("reads the outcome of a session end: refusal, error, or a clean end", () => {
    expect(
      routerFusionOutcomeOfSessionEnd({
        error: "Router + Fusion refused the call: RUN_BUDGET_EXHAUSTED",
        routerFusionRefusal: { code: "RUN_BUDGET_EXHAUSTED" },
      })
    ).toEqual({
      status: "failed",
      error: { code: "RUN_BUDGET_EXHAUSTED", message: "Router + Fusion refused a call." },
    })
    expect(routerFusionOutcomeOfSessionEnd({ error: "429" })).toEqual({
      status: "failed",
      error: { code: "TURN_ERROR", message: "429" },
    })
    expect(routerFusionOutcomeOfSessionEnd({})).toEqual({ status: "succeeded" })
  })
})
