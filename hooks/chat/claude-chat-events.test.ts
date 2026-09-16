/** @jest-environment jsdom */
jest.mock("@/lib/claude/permissions/auto-mode-runner", () => ({ runAutoModeForTool: jest.fn() }))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: jest.fn(() => null),
}))
const applySdkEventMock = jest.fn()
const mergeWebSearchSourcesMock = jest.fn((messages: unknown, _context?: unknown) => messages)
const mergeProjectHistorySourcesMock = jest.fn((messages: unknown, _evidence?: unknown) => messages)

jest.mock("@/lib/claude/adapter", () => {
  const actual = jest.requireActual("@/lib/claude/adapter")
  return {
    ...actual,
    applySdkEvent: (...args: unknown[]) => applySdkEventMock(...args),
    mergeWebSearchSourcesIntoLastAssistant: (messages: unknown, context: unknown) =>
      mergeWebSearchSourcesMock(messages, context),
    mergeProjectHistorySourcesIntoLastAssistant: (messages: unknown, evidence: unknown) =>
      mergeProjectHistorySourcesMock(messages, evidence),
  }
})

// Router + Fusion (ADR-0188) gate seams. The defaults are the off path: no
// session has a ledgered turn, so nothing is observed, sealed or loaded.
const mockRouterFusionGate = {
  handleRouterFusionSidecarFrame: jest.fn(async (..._args: unknown[]) => undefined),
  observeRouterFusionTurnMessage: jest.fn(
    (..._args: unknown[]): Promise<void> | undefined => undefined
  ),
  routerFusionTurnActive: jest.fn((_sessionId: string) => false),
  finishRouterFusionTurn: jest.fn(async (..._args: unknown[]): Promise<unknown> => null),
  finishAllRouterFusionTurns: jest.fn(
    (..._args: unknown[]): Promise<void> | undefined => undefined
  ),
}
jest.mock("@/lib/router-fusion/gate/chat-events", () => ({
  ...jest.requireActual("@/lib/router-fusion/gate/chat-events"),
  handleRouterFusionSidecarFrame: (...args: unknown[]) =>
    mockRouterFusionGate.handleRouterFusionSidecarFrame(...args),
  observeRouterFusionTurnMessage: (...args: unknown[]) =>
    mockRouterFusionGate.observeRouterFusionTurnMessage(...args),
  routerFusionTurnActive: (sessionId: string) =>
    mockRouterFusionGate.routerFusionTurnActive(sessionId),
  finishRouterFusionTurn: (...args: unknown[]) =>
    mockRouterFusionGate.finishRouterFusionTurn(...args),
  finishAllRouterFusionTurns: (...args: unknown[]) =>
    mockRouterFusionGate.finishAllRouterFusionTurns(...args),
}))
const mockAttemptRoutingFallback = jest.fn(async (..._args: unknown[]) => false)
jest.mock("@/lib/claude/routing-fallback", () => ({
  attemptRoutingFallback: (...args: unknown[]) => mockAttemptRoutingFallback(...args),
}))
const mockRecordProviderOutcome = jest.fn()
jest.mock("@/lib/claude/provider-telemetry", () => ({
  ...jest.requireActual("@/lib/claude/provider-telemetry"),
  recordProviderOutcome: (...args: unknown[]) => mockRecordProviderOutcome(...args),
}))
const mockRecordResultUsage = jest.fn(async (..._args: unknown[]) => null)
jest.mock("@/lib/db/session-usage", () => ({
  ...jest.requireActual("@/lib/db/session-usage"),
  recordResultUsage: (...args: unknown[]) => mockRecordResultUsage(...args),
}))
// The turn seal persists the transcript before it books usage; without a
// database that write rejects and the handler never reaches the usage row.
const mockPersistMessages = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/db/messages", () => ({
  ...jest.requireActual("@/lib/db/messages"),
  persistMessages: (...args: unknown[]) => mockPersistMessages(...args),
}))
const mockStandaloneChatMode = jest.fn(() => false)
jest.mock("@/lib/runtime/standalone-mode", () => ({
  ...jest.requireActual("@/lib/runtime/standalone-mode"),
  isStandaloneChatMode: () => mockStandaloneChatMode(),
}))

import { registerCaptureResponder } from "@/lib/connectors/hitl/approval-registry"
import { handleEvent, isArtifactAutoCreateEnabled, isTeamSubSession } from "./claude-chat-events"
import { SessionCoalescingRegistry } from "./stream-coalescing"
import { useChatStore } from "@/stores/chat"
import { clearSidecarLogTrail } from "@/lib/chat/sidecar-log-trail"
import {
  __clearAllProjectHistoryEvidenceForTesting,
  drainProjectHistoryEvidence,
  recordProjectHistoryEvidence,
} from "@/lib/claude/project-history-evidence-registry"

describe("Claude chat event seam", () => {
  it("leaves capture-owned response events to their registered responder", async () => {
    const release = registerCaptureResponder("captured", "turn", true)
    try {
      // No coalescer is needed: the response must be left to its owner before
      // any transcript or approval side effect starts.
      await expect(
        handleEvent(
          { type: "permission_request", sessionId: "captured", turnId: "turn" } as never,
          { current: null },
          { current: [] },
          { current: new Map() },
          { current: null },
          undefined as never
        )
      ).resolves.toBeUndefined()
    } finally {
      release()
    }
  })

  it("exports event routing and filters team sub-sessions", () => {
    expect(typeof handleEvent).toBe("function")
    expect(isTeamSubSession("team::char::member")).toBe(true)
  })
})

describe("artifact turn-complete policy", () => {
  it("requires both auto-create and agent authoring to remain enabled", () => {
    expect(isArtifactAutoCreateEnabled(undefined)).toBe(true)
    expect(isArtifactAutoCreateEnabled({ autoCreate: false })).toBe(false)
    expect(isArtifactAutoCreateEnabled({ agentAuthoring: false })).toBe(false)
  })
})

describe("pre-search source folding", () => {
  it("reads the current turn's cached web context at turnComplete", async () => {
    const webSearchContext = {
      provider: "tavily",
      results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
    }
    useChatStore.setState({
      sessions: {
        s1: {
          ...(useChatStore.getState().sessions.s1 ?? {}),
          messages: [],
          status: "streaming",
          pendingApprovals: [],
        },
      },
      openSessionIds: ["s1"],
      lastSendBySession: {
        s1: { content: "q", options: { webSearchContext }, attemptIndex: 0 },
      },
    } as never)
    applySdkEventMock.mockReturnValueOnce({
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "answer" }] }],
      turnComplete: true,
    })
    mergeWebSearchSourcesMock.mockImplementationOnce((messages) => messages)
    const registry = new SessionCoalescingRegistry({
      onCommit: () => {},
      onPersist: () => {},
      persistDelayMs: 0,
    })

    await handleEvent(
      { type: "event", sessionId: "s1", event: { type: "result" } } as never,
      { current: "s1" },
      { current: [] },
      { current: new Map() },
      { current: null },
      {
        messagesMirrorRef: { current: new Map() },
        registry,
        getExecutionHandle: () => undefined,
      } as never
    ).catch(() => {})

    expect(mergeWebSearchSourcesMock).toHaveBeenCalledWith(expect.any(Array), webSearchContext)
  })

  it("stamps the send's routing plan onto the completed assistant run metadata", async () => {
    const routingPlan = {
      decisionId: "d1",
      surface: "chat",
      requested: { kind: "auto" },
      strategy: "reliability",
      selected: { providerId: "anthropic", modelId: "claude-opus-4-8" },
      orderedCandidates: [{ providerId: "anthropic", modelId: "claude-opus-4-8" }],
      reasonCodes: ["auto-task-fit"],
      rejected: [],
      replayPolicy: "pre-commit-only",
      createdAt: 1,
    }
    useChatStore.setState({
      sessions: {
        s5: {
          ...(useChatStore.getState().sessions.s5 ?? {}),
          messages: [],
          status: "streaming",
          pendingApprovals: [],
        },
      },
      openSessionIds: ["s5"],
      lastSendBySession: {
        s5: { content: "q", options: { routingPlan }, attemptIndex: 0 },
      },
    } as never)
    applySdkEventMock.mockReturnValueOnce({
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "answer" }] }],
      turnComplete: true,
    })
    const registry = new SessionCoalescingRegistry({
      onCommit: () => {},
      onPersist: () => {},
      persistDelayMs: 0,
    })

    await handleEvent(
      { type: "event", sessionId: "s5", event: { type: "result" } } as never,
      { current: "s5" },
      { current: [] },
      { current: new Map() },
      { current: null },
      {
        messagesMirrorRef: { current: new Map() },
        registry,
        getExecutionHandle: () => undefined,
      } as never
    ).catch(() => {})

    const assistant = useChatStore
      .getState()
      .sessions.s5?.messages.find((m) => m.role === "assistant")
    const run = (assistant?.metadata as { run?: { routing?: unknown } } | undefined)?.run
    expect(run?.routing).toEqual({
      mode: "auto",
      strategy: "reliability",
      reasonCodes: ["auto-task-fit"],
      candidateCount: 1,
    })
  })
})

describe("sidecar log frames", () => {
  const ref = <T>(value: T) => ({ current: value }) as React.MutableRefObject<T>

  /**
   * The `sidecar_exited` branch ends with two Dexie writes
   * (`finishDirectChatExecutionRun`, `settleChatTranscript`) that have no
   * database in this environment. Everything under test — including the
   * diagnostic — is set before them, so the tail rejection is swallowed rather
   * than mocked away: mocking it would mean asserting against a handler that
   * is not the one that runs.
   */
  const dispatch = async (evt: unknown) => {
    const registry = new SessionCoalescingRegistry({
      onCommit: () => {},
      onPersist: () => {},
      persistDelayMs: 0,
    })
    await handleEvent(
      evt as never,
      ref<string | null>("s1"),
      ref<string[]>([]),
      ref(new Map<string, { groupId: string; index: number }>()),
      ref(null),
      {
        messagesMirrorRef: ref(new Map()),
        registry,
        getExecutionHandle: () => undefined,
      } as never
    ).catch(() => {})
  }

  beforeEach(() => {
    clearSidecarLogTrail()
    useChatStore.setState({
      sessions: {
        s1: {
          ...(useChatStore.getState().sessions.s1 ?? {}),
          messages: [],
          status: "streaming",
          pendingApprovals: [],
          errorDiagnostic: null,
        },
      },
      lastSendBySession: {},
    } as never)
  })

  it("never turns a log frame into a session failure on its own", async () => {
    // The whole reason these frames were dropped: a warning mid-turn is not the
    // turn's outcome, and rendering it would fail a turn that goes on to work.
    await dispatch({ type: "log", level: "error", message: "tool retry failed", sessionId: "s1" })
    const session = useChatStore.getState().sessions.s1!
    expect(session.errorDiagnostic).toBeNull()
    expect(session.status).toBe("streaming")
  })

  it("hands the last error line to the crash it explains", async () => {
    // `sidecarExited` used to be raised with no message at all — "the backend
    // stopped", with the stderr line that says why already discarded.
    await dispatch({ type: "log", level: "error", message: "ENOENT: node not found" })
    await dispatch({ type: "sidecar_exited", code: 1 })
    const diagnostic = useChatStore.getState().sessions.s1!.errorDiagnostic
    expect(diagnostic?.code).toBe("sidecarExited")
    expect(diagnostic?.message).toBe("ENOENT: node not found")
  })

  it("still reports a crash with no log line, rather than nothing", async () => {
    await dispatch({ type: "sidecar_exited", code: 137 })
    expect(useChatStore.getState().sessions.s1!.errorDiagnostic?.code).toBe("sidecarExited")
  })

  it("does not let an info-level line become a crash cause", async () => {
    await dispatch({ type: "log", level: "info", message: "listening on 3000" })
    await dispatch({ type: "sidecar_exited", code: 1 })
    // `createDiagnostic` defaults `message` to "", so absence reads as empty
    // rather than undefined — what matters is that routine startup chatter
    // never gets presented as the reason a process died.
    expect(useChatStore.getState().sessions.s1!.errorDiagnostic?.message).toBe("")
  })
})

describe("project-history evidence folding", () => {
  afterEach(() => {
    __clearAllProjectHistoryEvidenceForTesting()
    mergeProjectHistorySourcesMock.mockClear()
  })

  async function runTurn(sessionId: string) {
    useChatStore.setState({
      sessions: {
        [sessionId]: {
          ...(useChatStore.getState().sessions[sessionId] ?? {}),
          messages: [],
          status: "streaming",
          pendingApprovals: [],
        },
      },
      openSessionIds: [sessionId],
      lastSendBySession: {
        [sessionId]: { content: "q", options: {}, attemptIndex: 0 },
      },
    } as never)
    applySdkEventMock.mockReturnValueOnce({
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "answer" }] }],
      turnComplete: true,
    })
    const registry = new SessionCoalescingRegistry({
      onCommit: () => {},
      onPersist: () => {},
      persistDelayMs: 0,
    })
    await handleEvent(
      { type: "event", sessionId, event: { type: "result" } } as never,
      { current: sessionId },
      { current: [] },
      { current: new Map() },
      { current: null },
      {
        messagesMirrorRef: { current: new Map() },
        registry,
        getExecutionHandle: () => undefined,
      } as never
    ).catch(() => {})
  }

  const evidence = {
    id: "m-7",
    kind: "message" as const,
    sessionId: "s-old",
    messageId: "m-7",
    title: "Repo setup",
    snippet: "pnpm workspaces",
    createdAt: 10,
  }

  it("cites what the tool read during this turn", async () => {
    recordProjectHistoryEvidence("s2", [evidence])
    await runTurn("s2")
    expect(mergeProjectHistorySourcesMock).toHaveBeenCalledWith(expect.any(Array), [evidence])
  })

  it("does not fold when the tool was never called", async () => {
    await runTurn("s3")
    expect(mergeProjectHistorySourcesMock).not.toHaveBeenCalled()
  })

  it("CLEARS the evidence, so the next turn cannot re-cite it", async () => {
    recordProjectHistoryEvidence("s4", [evidence])
    await runTurn("s4")
    expect(mergeProjectHistorySourcesMock).toHaveBeenCalledTimes(1)
    expect(drainProjectHistoryEvidence("s4")).toEqual([])
  })
})

describe("Router + Fusion turn wiring (ADR-0188)", () => {
  const ref = <T>(value: T) => ({ current: value }) as React.MutableRefObject<T>
  const route = {
    runId: "rf-1",
    decisionId: "dec-1",
    actionId: "direct_baseline",
    mode: "direct",
    ruleId: null,
    deploymentId: "openai::gpt-5",
    providerId: "openai",
    modelId: "gpt-5",
    budgetMode: "tracked",
    capMicrousd: 500_000,
    reserveEstimateMicrousd: 12_000,
    priceKnown: true,
    acceptanceProfile: "text_basic",
    lane: "ai-sdk",
  }
  const summary = {
    runId: "rf-1",
    status: "succeeded",
    spentMicrousd: 4_200,
    overspendMicrousd: 0,
    modelCalls: 2,
    costStatus: "actual",
    frozen: false,
    refusalCode: null,
    bypass: null,
  }

  const dispatch = async (evt: unknown, sessionId = "rf") => {
    const registry = new SessionCoalescingRegistry({
      onCommit: () => {},
      onPersist: () => {},
      persistDelayMs: 0,
    })
    await handleEvent(
      evt as never,
      ref<string | null>(sessionId),
      ref<string[]>([]),
      ref(new Map<string, { groupId: string; index: number }>()),
      ref(null),
      {
        messagesMirrorRef: ref(new Map()),
        registry,
        getExecutionHandle: () => undefined,
      } as never
    ).catch(() => {})
  }

  const seed = (options: Record<string, unknown>) =>
    useChatStore.setState({
      sessions: {
        rf: {
          ...(useChatStore.getState().sessions.rf ?? {}),
          messages: [],
          status: "streaming",
          pendingApprovals: [],
          errorDiagnostic: null,
        },
      },
      openSessionIds: ["rf"],
      lastSendBySession: { rf: { content: "q", options, attemptIndex: 0 } },
    } as never)

  const resultTurn = () =>
    applySdkEventMock.mockReturnValueOnce({
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "answer" }] }],
      turnComplete: true,
      result: { type: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 5 } },
    })

  const assistantRun = () =>
    (
      useChatStore.getState().sessions.rf?.messages.find((m) => m.role === "assistant")
        ?.metadata as { run?: Record<string, unknown> } | undefined
    )?.run

  beforeEach(() => {
    for (const fn of Object.values(mockRouterFusionGate)) fn.mockClear()
    mockRouterFusionGate.routerFusionTurnActive.mockReturnValue(false)
    mockRouterFusionGate.finishRouterFusionTurn.mockResolvedValue(null)
    mockRouterFusionGate.finishAllRouterFusionTurns.mockReturnValue(undefined)
    mockRouterFusionGate.observeRouterFusionTurnMessage.mockReturnValue(undefined)
    mockAttemptRoutingFallback.mockReset().mockResolvedValue(false)
    mockRecordProviderOutcome.mockReset()
    mockRecordResultUsage.mockReset().mockResolvedValue(null)
  })

  it("hands the three ledger frames to Router + Fusion", async () => {
    const frames = [
      { type: "call_reserve_request", sessionId: "rf", runId: "rf-1", requestId: "q1" },
      { type: "call_attempt_result", sessionId: "rf", runId: "rf-1", attemptId: "a1" },
      { type: "ledger_bypassed", sessionId: "rf", reason: "timeout" },
    ]
    for (const frame of frames) await dispatch(frame)
    expect(mockRouterFusionGate.handleRouterFusionSidecarFrame.mock.calls.map(([f]) => f)).toEqual(
      frames
    )
  })

  it("[ACC:OFF-02] leaves an unledgered turn's result, metadata and usage exactly as before", async () => {
    seed({ provider: "anthropic", model: "sonnet" })
    resultTurn()
    await dispatch({ type: "event", sessionId: "rf", event: { type: "result" } })
    expect(mockRouterFusionGate.observeRouterFusionTurnMessage).toHaveBeenCalledTimes(1)
    expect(mockRouterFusionGate.finishRouterFusionTurn).not.toHaveBeenCalled()
    expect(assistantRun()).not.toHaveProperty("routerFusion")
    expect(mockRecordResultUsage).toHaveBeenCalledTimes(1)
    expect(mockRecordResultUsage.mock.calls[0][0]).not.toHaveProperty("ledger")
  })

  it("seals a ledgered turn at its result and books the ledger's cost on the message and usage row", async () => {
    seed({ provider: "openai", model: "gpt-5", routerFusion: route })
    mockRouterFusionGate.routerFusionTurnActive.mockReturnValue(true)
    mockRouterFusionGate.finishRouterFusionTurn.mockResolvedValue(summary)
    let booked = false
    mockRouterFusionGate.observeRouterFusionTurnMessage.mockImplementation(() =>
      Promise.resolve().then(() => {
        booked = true
      })
    )
    mockRouterFusionGate.finishRouterFusionTurn.mockImplementation(async () => {
      // The envelope booked the result before the seal read it.
      expect(booked).toBe(true)
      return summary
    })
    resultTurn()
    await dispatch({ type: "event", sessionId: "rf", event: { type: "result" } })
    expect(mockRouterFusionGate.finishRouterFusionTurn).toHaveBeenCalledWith("rf", {
      status: "succeeded",
    })
    expect(assistantRun()?.routerFusion).toEqual({
      route,
      outcome: {
        status: "succeeded",
        spentMicrousd: 4_200,
        overspendMicrousd: 0,
        modelCalls: 2,
        costStatus: "actual",
        frozen: false,
        refusalCode: null,
      },
    })
    expect(mockRecordResultUsage).toHaveBeenCalledWith(
      expect.objectContaining({ ledger: { runId: "rf-1", costUsd: 0.0042 } })
    )
  })

  it("[ACC:ISO-01] records a send that bypassed Router + Fusion on the message", async () => {
    seed({
      provider: "openai",
      model: "gpt-5",
      routerFusionBypass: { code: "db_unavailable", justTripped: true },
    })
    resultTurn()
    await dispatch({ type: "event", sessionId: "rf", event: { type: "result" } })
    expect(assistantRun()?.routerFusion).toEqual({
      bypass: { code: "db_unavailable", justTripped: true },
    })
    expect(mockRecordResultUsage.mock.calls[0][0]).not.toHaveProperty("ledger")
  })

  it("[ACC:ISO-04] ends a refused turn with the refusal, without a breaker record or a fallback", async () => {
    seed({ provider: "openai", model: "gpt-5", routerFusion: route })
    mockRouterFusionGate.routerFusionTurnActive.mockReturnValue(true)
    await dispatch({
      type: "session_ended",
      sessionId: "rf",
      error: "Router + Fusion refused the call: RUN_BUDGET_EXHAUSTED",
      routerFusionRefusal: { code: "RUN_BUDGET_EXHAUSTED" },
    })
    expect(mockRouterFusionGate.finishRouterFusionTurn).toHaveBeenCalledWith("rf", {
      status: "failed",
      error: { code: "RUN_BUDGET_EXHAUSTED", message: "Router + Fusion refused a call." },
    })
    expect(mockRecordProviderOutcome).not.toHaveBeenCalled()
    expect(mockAttemptRoutingFallback).not.toHaveBeenCalled()
    expect(useChatStore.getState().sessions.rf?.errorDiagnostic?.code).toBe("routerFusionRefused")
  })

  it("keeps the sidecar's own words and the turn's span on the refusal diagnostic", async () => {
    seed({ provider: "openai", model: "gpt-5", routerFusion: route, spanId: "span-7" })
    mockRouterFusionGate.routerFusionTurnActive.mockReturnValue(true)
    await dispatch({
      type: "session_ended",
      sessionId: "rf",
      error: "Router + Fusion refused the call: CALL_LIMIT_EXCEEDED",
      // The sidecar only ever sends machine codes as the message (ADR-0188 PII).
      routerFusionRefusal: { code: "CALL_LIMIT_EXCEEDED", message: "withheld" },
    })
    const diagnostic = useChatStore.getState().sessions.rf?.errorDiagnostic as {
      code: string
      detail?: string
      meta?: { spanId?: string }
    }
    expect(diagnostic.code).toBe("routerFusionRefused")
    expect(diagnostic.detail).toBe("CALL_LIMIT_EXCEEDED\nwithheld")
    expect(diagnostic.meta?.spanId).toBe("span-7")
  })

  it("seals a failed ledgered turn before a routing fallback may start the next run", async () => {
    seed({ provider: "openai", model: "gpt-5", routerFusion: route })
    mockRouterFusionGate.routerFusionTurnActive.mockReturnValue(true)
    await dispatch({ type: "session_ended", sessionId: "rf", error: "overloaded", httpStatus: 529 })
    expect(mockRouterFusionGate.finishRouterFusionTurn).toHaveBeenCalledWith("rf", {
      status: "failed",
      error: { code: "TURN_ERROR", message: "overloaded" },
    })
    expect(mockRecordProviderOutcome).toHaveBeenCalled()
    expect(mockAttemptRoutingFallback).toHaveBeenCalled()
    expect(mockRouterFusionGate.finishRouterFusionTurn.mock.invocationCallOrder[0]).toBeLessThan(
      mockAttemptRoutingFallback.mock.invocationCallOrder[0]
    )
  })

  it("[ACC:OFF-02] does not touch Router + Fusion when an unledgered turn ends", async () => {
    seed({ provider: "anthropic", model: "sonnet" })
    await dispatch({ type: "session_ended", sessionId: "rf", error: "overloaded" })
    expect(mockRouterFusionGate.finishRouterFusionTurn).not.toHaveBeenCalled()
    expect(mockAttemptRoutingFallback).toHaveBeenCalled()
    expect(useChatStore.getState().sessions.rf?.errorDiagnostic?.code).not.toBe(
      "routerFusionRefused"
    )
  })

  it("seals every ledgered turn when the sidecar exits", async () => {
    let sealed = false
    mockRouterFusionGate.finishAllRouterFusionTurns.mockImplementation(() =>
      Promise.resolve().then(() => {
        sealed = true
      })
    )
    await dispatch({ type: "sidecar_exited", code: 1 })
    expect(mockRouterFusionGate.finishAllRouterFusionTurns).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SIDECAR_EXITED" })
    )
    expect(sealed).toBe(true)
  })
})

describe("renderer broker Auto-mode responder", () => {
  it.each(["allow", "deny", "ask"] as const)(
    "routes %s without requiring the native SDK approval transport",
    async (decision) => {
      const { runAutoModeForTool } = await import("@/lib/claude/permissions/auto-mode-runner")
      const { tryAutoModeDecision } = await import("./claude-chat-events")
      jest
        .mocked(runAutoModeForTool)
        .mockResolvedValueOnce({ decision, source: "rules", reason: "fixture" } as never)
      const respond = jest.fn(async (_decision: "allow" | "deny", _message?: string) => {})
      const handled = await tryAutoModeDecision(
        {
          sessionId: "chat",
          requestId: "external-tool-host:test",
          toolName: "Bash",
          input: { command: "pwd" },
        },
        respond
      )
      expect(handled).toBe(decision !== "ask")
      if (decision === "ask") expect(respond).not.toHaveBeenCalled()
      else expect(respond.mock.calls[0][0]).toBe(decision)
    }
  )
})
