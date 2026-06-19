/**
 * @jest-environment jsdom
 *
 * Coverage focus: the deterministic action surface of `useClaudeChat`.
 * The hook also wires a long-lived sidecar event handler through `onClaudeMessage`
 * — that handler is exercised indirectly via `send` / `respondToApproval`.
 */
import { act, renderHook } from "@testing-library/react"

import { useAgentRuntimeStore, useExternalAgentStore } from "@/stores/agent"

// `stores/index.ts` calls `isTauri()` at module top-level; declaring the
// jest.fn inside the factory dodges the TDZ that closures over an outer
// const would otherwise hit during ES import hoisting.
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn().mockReturnValue(true),
}))
const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri

const onClaudeUnsub = jest.fn()
let _messageCallback: ((evt: unknown) => void) | null = null
const onClaudeMessageMock = jest.fn(async (cb: (evt: unknown) => void) => {
  _messageCallback = cb
  return onClaudeUnsub
})
const sendPromptMock = jest.fn().mockResolvedValue(undefined)
const interruptSessionMock = jest.fn().mockResolvedValue(undefined)
const closeSessionIpcMock = jest.fn().mockResolvedValue(undefined)
const approveToolMock = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/claude/ipc", () => ({
  approveTool: (...a: unknown[]) => approveToolMock(...a),
  closeSession: (id: string) => closeSessionIpcMock(id),
  interruptSession: (id: string) => interruptSessionMock(id),
  onClaudeMessage: (cb: (evt: unknown) => void) => onClaudeMessageMock(cb),
  sendPrompt: (...a: unknown[]) => sendPromptMock(...a),
}))

jest.mock("@/lib/claude/adapter", () => ({
  applySdkEvent: jest.fn(() => ({ messages: [], turnComplete: false })),
  contentPreview: (c: unknown) => (typeof c === "string" ? c : "preview"),
  makeUserMessage: (c: unknown) => ({ id: "u1", role: "user", parts: [{ type: "text", text: c }] }),
  extractUsage: jest.fn(() => null),
  mergeTwinSourcesIntoLastAssistant: (msgs: unknown) => msgs,
}))

jest.mock("@/lib/plugin/messaging/message-bus", () => {
  const actual = jest.requireActual("@/lib/plugin/messaging/message-bus")
  return { ...actual, emitSystemBusEvent: jest.fn() }
})
const busEmitMock = (
  jest.requireMock("@/lib/plugin/messaging/message-bus") as {
    emitSystemBusEvent: jest.Mock
  }
).emitSystemBusEvent
const { SystemEvents: BusEvents } = jest.requireActual(
  "@/lib/plugin/messaging/message-bus"
) as typeof import("@/lib/plugin/messaging/message-bus")

// ADR-0019 goal wiring — mock the runtime/turn-driver/judge-client so `send`
// and the turn-complete handler don't reach real Dexie. Defaults make the
// no-goal path a no-op (getActiveGoalForSession → undefined).
const goalRuntimeMock = {
  getActiveGoalForSession: jest.fn().mockResolvedValue(undefined),
  pauseGoal: jest.fn().mockResolvedValue(null),
  registerAbortController: jest.fn(() => () => {}),
  onManualContinue: jest.fn(() => () => {}),
  requestManualContinue: jest.fn(),
  recordPacingDecision: jest.fn().mockResolvedValue(undefined),
}
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => goalRuntimeMock,
}))
// Same posture for the /loop runtime — defaults make the no-loop path a
// no-op (getActiveLoopForSession → undefined) so send()/turn-complete
// never reach real Dexie.
const loopRuntimeMock = {
  getActiveLoopForSession: jest.fn().mockResolvedValue(undefined),
  pauseLoop: jest.fn().mockResolvedValue(null),
  registerAbortController: jest.fn(() => () => {}),
  // NB: typed param so tests can mockImplementation((cb) => …) — a bare
  // jest.fn(() => …) infers a zero-arg signature (TS2345).
  onKickoff: jest.fn((_cb: (loop: unknown) => void) => () => {}),
}
jest.mock("@/lib/loop/runtime", () => ({
  getLoopRuntime: () => loopRuntimeMock,
}))
const handleLoopTurnCompleteMock = jest.fn()
jest.mock("@/lib/loop/turn-driver", () => ({
  handleLoopTurnComplete: (...a: unknown[]) => handleLoopTurnCompleteMock(...a),
}))
const handleTurnCompleteMock = jest.fn()
jest.mock("@/lib/goal/turn-driver", () => ({
  handleTurnComplete: (...a: unknown[]) => handleTurnCompleteMock(...a),
}))
const buildGoalJudgeClientMock = jest.fn()
jest.mock("@/lib/goal/judge-client", () => ({
  buildGoalJudgeClient: (...a: unknown[]) => buildGoalJudgeClientMock(...a),
}))

const persistMessagesMock = jest.fn().mockResolvedValue(undefined)
const truncateAfterMock = jest.fn().mockResolvedValue(undefined)
const listMessagesMock = jest.fn().mockResolvedValue([])
jest.mock("@/lib/db/messages", () => ({
  listMessages: (id: string) => listMessagesMock(id),
  persistMessages: (...a: unknown[]) => persistMessagesMock(...a),
  truncateAfter: (...a: unknown[]) => truncateAfterMock(...a),
}))

const getSessionMock = jest.fn()
const setSdkSessionIdMock = jest.fn().mockResolvedValue(undefined)
const touchSessionMock = jest.fn().mockResolvedValue(undefined)
const updateSessionMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/sessions", () => ({
  getSession: (id: string) => getSessionMock(id),
  setSdkSessionId: (...a: unknown[]) => setSdkSessionIdMock(...a),
  touchSession: (id: string) => touchSessionMock(id),
  updateSession: (...a: unknown[]) => updateSessionMock(...a),
}))

jest.mock("@/lib/db/session-state", () => ({
  bumpUnread: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({ model: "sonnet", systemPrompt: "sys" })),
}))

const dispatchUserPromptSubmitMock = jest.fn(async () => ({ action: "proceed" as const }))
const dispatchChatErrorMock = jest.fn()
const dispatchTokenUsageMock = jest.fn()
jest.mock("@/lib/claude/adapter-hooks", () => ({
  dispatchUserPromptSubmit: (...a: unknown[]) => dispatchUserPromptSubmitMock(...(a as [])),
  dispatchChatError: (...a: unknown[]) => dispatchChatErrorMock(...(a as [])),
  dispatchTokenUsage: (...a: unknown[]) => dispatchTokenUsageMock(...(a as [])),
}))

// External-agent branch (D1): dynamically imported by `send` when the agent
// runtime is "external". Mock both so the branch is drivable from a test.
const externalEventState = { callsAtSwitch: -1 }
const executeOnExternalAgentMock = jest.fn()
const getConnectedAgentsMock = jest.fn<unknown[], []>(() => [])
const checkDelegationMock = jest.fn(
  (): {
    shouldDelegate: boolean
    targetAgentId?: string
    matchedRule?: { id: string; name: string }
    reasonCode?: string
  } => ({ shouldDelegate: false })
)
const setDelegationRulesMock = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  executeOnExternalAgent: (...a: unknown[]) => executeOnExternalAgentMock(...(a as [])),
  getExternalAgentManager: () => ({
    getConnectedAgents: () => getConnectedAgentsMock(),
    checkDelegation: (...a: unknown[]) => checkDelegationMock(...(a as [])),
    setDelegationRules: (...a: unknown[]) => setDelegationRulesMock(...(a as [])),
  }),
}))
jest.mock("@/lib/ai/agent/external/event-to-parts", () => ({
  applyExternalAgentEventToParts: (parts: unknown) => [
    ...((parts as unknown[]) ?? []),
    { type: "text", text: "x", state: "streaming" },
  ],
}))

interface ChatStateLike {
  activeSessionId: string | null
  messages: unknown[]
  pendingApprovals: unknown[]
  pendingCommandOverrides: unknown
  referencedPaths: unknown[]
  lastSendBySession: Record<string, unknown>
  setActiveSession: jest.Mock
  setMessages: jest.Mock
  replaceMessages: jest.Mock
  appendMessage: jest.Mock
  setStatus: jest.Mock
  setError: jest.Mock
  pushApproval: jest.Mock
  clearApproval: jest.Mock
  setPendingCommandOverrides: jest.Mock
  setLastSend: jest.Mock
  clearLastSend: jest.Mock
}

const chatState: ChatStateLike = {
  activeSessionId: "sess-1",
  messages: [],
  pendingApprovals: [],
  pendingCommandOverrides: null,
  referencedPaths: [],
  lastSendBySession: {},
  setActiveSession: jest.fn(),
  setMessages: jest.fn(),
  replaceMessages: jest.fn(),
  appendMessage: jest.fn(),
  setStatus: jest.fn(),
  setError: jest.fn(),
  pushApproval: jest.fn(),
  clearApproval: jest.fn(),
  setPendingCommandOverrides: jest.fn(),
  setLastSend: jest.fn(),
  clearLastSend: jest.fn(),
}

const subscribers: Array<(s: ChatStateLike) => void> = []

jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(<T>(selector: (s: ChatStateLike) => T): T => selector(chatState), {
    getState: () => chatState,
    subscribe: (fn: (s: ChatStateLike) => void) => {
      subscribers.push(fn)
      return () => {
        const i = subscribers.indexOf(fn)
        if (i >= 0) subscribers.splice(i, 1)
      }
    },
  }),
}))

const settingsState = {
  settings: { alwaysAllowTools: [] as string[], artifacts: { autoCreate: false } },
  toggleAlwaysAllow: jest.fn().mockResolvedValue(undefined),
}
const settingsSubscribers: Array<(s: typeof settingsState) => void> = []

// The background utility client is irrelevant to these tests (Auto-mode uses
// the deterministic rules tier without it); stub it to null so no real
// provider resolution runs.
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: () => null,
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    <T>(selector: (s: typeof settingsState) => T): T => selector(settingsState),
    {
      getState: () => settingsState,
      subscribe: (fn: (s: typeof settingsState) => void) => {
        settingsSubscribers.push(fn)
        return () => {
          const i = settingsSubscribers.indexOf(fn)
          if (i >= 0) settingsSubscribers.splice(i, 1)
        }
      },
    }
  ),
}))

jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: { getState: () => ({ autoCreateFromContent: jest.fn() }) },
}))

const mockGetTwinRuntimeSettings = jest.fn()
jest.mock("@/lib/db/twin-runtime-settings", () => ({
  getTwinRuntimeSettings: () => mockGetTwinRuntimeSettings(),
}))

const mockCreateVectorStore = jest.fn()
jest.mock("@/lib/vector/store", () => ({
  createVectorStore: (...args: unknown[]) => mockCreateVectorStore(...args),
}))

import { useClaudeChat } from "./use-claude-chat"

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(true)
  _messageCallback = null
  busEmitMock.mockClear()
  onClaudeMessageMock.mockClear()
  onClaudeUnsub.mockClear()
  sendPromptMock.mockReset().mockResolvedValue(undefined)
  interruptSessionMock.mockReset().mockResolvedValue(undefined)
  closeSessionIpcMock.mockReset().mockResolvedValue(undefined)
  approveToolMock.mockReset().mockResolvedValue(undefined)
  persistMessagesMock.mockReset().mockResolvedValue(undefined)
  truncateAfterMock.mockReset().mockResolvedValue(undefined)
  listMessagesMock.mockReset().mockResolvedValue([])
  getSessionMock.mockReset().mockResolvedValue({
    id: "sess-1",
    title: "New chat",
    model: "sonnet",
  })
  setSdkSessionIdMock.mockClear()
  touchSessionMock.mockClear()
  updateSessionMock.mockReset().mockResolvedValue(undefined)
  chatState.activeSessionId = "sess-1"
  chatState.messages = []
  chatState.pendingApprovals = []
  chatState.pendingCommandOverrides = null
  chatState.referencedPaths = []
  chatState.lastSendBySession = {}
  chatState.setActiveSession.mockClear()
  chatState.setMessages.mockClear()
  chatState.replaceMessages.mockClear()
  chatState.appendMessage.mockClear()
  chatState.setStatus.mockClear()
  chatState.setError.mockClear()
  chatState.pushApproval.mockClear()
  chatState.clearApproval.mockClear()
  chatState.setPendingCommandOverrides.mockClear()
  subscribers.length = 0
  settingsSubscribers.length = 0
  mockGetTwinRuntimeSettings.mockReset()
  mockCreateVectorStore.mockReset()
  goalRuntimeMock.getActiveGoalForSession.mockReset().mockResolvedValue(undefined)
  goalRuntimeMock.pauseGoal.mockReset().mockResolvedValue(null)
  goalRuntimeMock.registerAbortController.mockReset().mockReturnValue(() => {})
  goalRuntimeMock.onManualContinue.mockReset().mockReturnValue(() => {})
  goalRuntimeMock.requestManualContinue.mockReset()
  goalRuntimeMock.recordPacingDecision.mockReset().mockResolvedValue(undefined)
  loopRuntimeMock.getActiveLoopForSession.mockReset().mockResolvedValue(undefined)
  loopRuntimeMock.pauseLoop.mockReset().mockResolvedValue(null)
  loopRuntimeMock.registerAbortController.mockReset().mockReturnValue(() => {})
  loopRuntimeMock.onKickoff.mockReset().mockReturnValue(() => {})
  handleLoopTurnCompleteMock.mockReset()
  handleTurnCompleteMock.mockReset()
  buildGoalJudgeClientMock.mockReset().mockReturnValue(null)
  executeOnExternalAgentMock.mockReset()
  getConnectedAgentsMock.mockReset().mockReturnValue([])
  checkDelegationMock.mockReset().mockReturnValue({ shouldDelegate: false })
  setDelegationRulesMock.mockReset()
})

async function flush() {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0))
  })
}

afterEach(() => {
  // The external-branch test flips the (real) agent-runtime store; reset it so
  // subsequent tests keep taking the default claude-sdk path.
  useAgentRuntimeStore.setState({ runtime: "claude-sdk", externalAgentId: null })
  useExternalAgentStore.setState({ delegationRules: [], chatFailurePolicy: "fallback" })
})

describe("useClaudeChat — actions", () => {
  it("send() guards against empty string content", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("   ")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("send() guards against empty array content", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send([] as never)
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("send() with text rolls through persist + sendPrompt", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(persistMessagesMock).toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled()
    expect(touchSessionMock).toHaveBeenCalledWith("sess-1")
    // Plugin bus: the committed send announces MESSAGE_SENT + AGENT_STARTED.
    expect(busEmitMock).toHaveBeenCalledWith(BusEvents.MESSAGE_SENT, { sessionId: "sess-1" })
    expect(busEmitMock).toHaveBeenCalledWith(BusEvents.AGENT_STARTED, { sessionId: "sess-1" })
  })

  it("guards external-agent writes against a mid-run session switch (D1)", async () => {
    useAgentRuntimeStore.setState({ runtime: "external", externalAgentId: "ext-1" })
    chatState.activeSessionId = "sess-1"
    executeOnExternalAgentMock.mockImplementation(
      async (_text: string, opts: { onEvent: (e: unknown) => void }) => {
        // First delta arrives while sess-1 is active → writeAssistant fires.
        opts.onEvent({ type: "text", text: "a" })
        externalEventState.callsAtSwitch = chatState.replaceMessages.mock.calls.length
        // User switches away mid-run; push it through the subscriber so the
        // hook's `activeRef` reflects the new active session.
        chatState.activeSessionId = "sess-other"
        subscribers.forEach((sub) => sub(chatState))
        // Second delta after the switch → writeAssistant must be a no-op.
        opts.onEvent({ type: "text", text: "b" })
        return { success: true, finalResponse: "done" }
      }
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send("hi")
    })
    // No replaceMessages call happened after the switch (otherwise the
    // now-active "sess-other" would be clobbered with sess-1's baseList).
    expect(externalEventState.callsAtSwitch).toBeGreaterThanOrEqual(1)
    expect(chatState.replaceMessages.mock.calls.length).toBe(externalEventState.callsAtSwitch)
    // Persist still targets THIS session id, built locally (not the live store).
    expect(persistMessagesMock).toHaveBeenCalledWith("sess-1", expect.any(Array))
  })

  it("delegates a matching turn to the external agent (Thread B)", async () => {
    chatState.activeSessionId = "sess-1"
    getConnectedAgentsMock.mockReturnValue([{ config: { id: "ext-1" } }])
    checkDelegationMock.mockReturnValue({
      shouldDelegate: true,
      targetAgentId: "ext-1",
      matchedRule: { id: "r1", name: "Code → CC" },
      reasonCode: "ok",
    })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "delegated done" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send("refactor this module")
    })
    expect(setDelegationRulesMock).toHaveBeenCalled()
    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "refactor this module",
      expect.objectContaining({ agentId: "ext-1" })
    )
    // Built-in SDK path did NOT run for the delegated turn.
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("does not delegate when no external agents are connected", async () => {
    getConnectedAgentsMock.mockReturnValue([])
    checkDelegationMock.mockReturnValue({ shouldDelegate: true, targetAgentId: "ext-1" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("refactor this module")
    })
    expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled() // built-in path ran
  })

  it("falls back to the built-in path when a delegated turn fails (fallback policy)", async () => {
    useExternalAgentStore.setState({ chatFailurePolicy: "fallback" })
    getConnectedAgentsMock.mockReturnValue([{ config: { id: "ext-1" } }])
    checkDelegationMock.mockReturnValue({ shouldDelegate: true, targetAgentId: "ext-1" })
    executeOnExternalAgentMock.mockResolvedValue({ success: false, error: "spawn failed" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send("refactor this module")
    })
    // Fallback re-entry runs the SDK path.
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("surfaces the error without fallback under the strict policy", async () => {
    useExternalAgentStore.setState({ chatFailurePolicy: "strict" })
    getConnectedAgentsMock.mockReturnValue([{ config: { id: "ext-1" } }])
    checkDelegationMock.mockReturnValue({ shouldDelegate: true, targetAgentId: "ext-1" })
    executeOnExternalAgentMock.mockResolvedValue({ success: false, error: "spawn failed" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send("refactor this module")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(chatState.setError).toHaveBeenCalledWith("spawn failed")
  })

  it("send() updates the title for a new session and marks it machine-set", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("new prompt")
    })
    expect(updateSessionMock).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ title: expect.any(String), titleAuto: true })
    )
  })

  it("send() does not overwrite a manually-renamed (non-placeholder) title", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "My renamed chat",
      titleAuto: false,
      model: "sonnet",
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("new prompt")
    })
    expect(updateSessionMock).not.toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ title: expect.any(String) })
    )
  })

  it("send() surfaces error when no active session", async () => {
    chatState.activeSessionId = null
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(chatState.setError).toHaveBeenCalledWith("No session selected")
  })

  it("send() applies pending command overrides", async () => {
    chatState.pendingCommandOverrides = {
      model: "opus",
      allowedTools: ["read"],
      paths: ["/x"],
    }
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(chatState.setPendingCommandOverrides).toHaveBeenCalledWith(null)
  })

  it("send() consults the plugin onUserPromptSubmit hook before sending", async () => {
    dispatchUserPromptSubmitMock.mockResolvedValueOnce({ action: "proceed" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(dispatchUserPromptSubmitMock).toHaveBeenCalledWith("hello", "sess-1", expect.any(Object))
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("send() bails when a plugin returns action:'block'", async () => {
    dispatchUserPromptSubmitMock.mockResolvedValueOnce({
      action: "block",
      reason: "policy violation",
    } as never)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("nope")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(chatState.setError).toHaveBeenCalledWith("policy violation")
  })

  it("send() rewrites the prompt when a plugin returns action:'modify'", async () => {
    dispatchUserPromptSubmitMock.mockResolvedValueOnce({
      action: "modify",
      modifiedPrompt: "rewritten",
    } as never)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("original")
    })
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "rewritten", expect.any(Object))
  })

  it("send() folds plugin additionalContext into appendSystemPrompt", async () => {
    dispatchUserPromptSubmitMock.mockResolvedValueOnce({
      action: "modify",
      additionalContext: "extra system note",
    } as never)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(sendPromptMock).toHaveBeenCalledWith(
      "sess-1",
      "hello",
      expect.objectContaining({ appendSystemPrompt: "extra system note" })
    )
  })

  it("send() calls dispatchChatError when sendPrompt throws", async () => {
    sendPromptMock.mockRejectedValueOnce(new Error("network down"))
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(chatState.setError).toHaveBeenCalledWith("network down")
    expect(dispatchChatErrorMock).toHaveBeenCalledWith("sess-1", expect.any(Error))
  })

  it("stop() interrupts the active session", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.stop()
    })
    expect(interruptSessionMock).toHaveBeenCalledWith("sess-1")
  })

  it("stop() is a no-op without an active session", async () => {
    chatState.activeSessionId = null
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.stop()
    })
    expect(interruptSessionMock).not.toHaveBeenCalled()
  })

  it("close() forwards to closeSession", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.close("sess-1")
    })
    expect(closeSessionIpcMock).toHaveBeenCalledWith("sess-1")
  })

  it("respondToApproval (allow): forwards to approveTool", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "r-1",
          toolName: "read",
        } as never,
        "allow"
      )
    })
    expect(approveToolMock).toHaveBeenCalledWith("sess-1", "r-1", "allow")
    expect(chatState.clearApproval).toHaveBeenCalledWith("r-1")
  })

  it("respondToApproval (allow_always) toggles the always-allow list", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "r-1",
          toolName: "read",
        } as never,
        "allow_always"
      )
    })
    expect(settingsState.toggleAlwaysAllow).toHaveBeenCalledWith("read", true)
    expect(approveToolMock).toHaveBeenCalledWith("sess-1", "r-1", "allow")
  })

  it("respondToApproval (deny) forwards deny to approveTool", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "r-1",
          toolName: "read",
        } as never,
        "deny"
      )
    })
    expect(approveToolMock).toHaveBeenCalledWith("sess-1", "r-1", "deny")
  })

  it("editAndResend truncates and re-sends", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.editAndResend("m-1", "edited")
    })
    expect(truncateAfterMock).toHaveBeenCalledWith("sess-1", "m-1", { inclusive: true })
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("regenerate is a no-op when there is no user message", async () => {
    chatState.messages = []
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.regenerate()
    })
    expect(truncateAfterMock).not.toHaveBeenCalled()
  })

  it("regenerate tags the existing assistant siblings and re-sends without re-appending the user turn", async () => {
    chatState.messages = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.regenerate()
    })

    // Branch-aware regenerate no longer truncates — siblings are preserved
    // and stamped with branchGroupId / branchIndex via persistMessages.
    expect(truncateAfterMock).not.toHaveBeenCalled()
    expect(persistMessagesMock).toHaveBeenCalled()
    // Find the persist call that wrote the branch-tagged snapshot. send()
    // and applySdkEvent may also persist, so we scan rather than peek
    // at the last call.
    const taggingCall = persistMessagesMock.mock.calls.find((args) => {
      const list = args[1] as Array<{ id: string; metadata?: { branchGroupId?: string } }>
      return Array.isArray(list) && list.some((m) => m.id === "a-1" && m.metadata?.branchGroupId)
    })
    expect(taggingCall).toBeTruthy()
    expect(taggingCall?.[0]).toBe("sess-1")
    const merged = taggingCall?.[1] as Array<{
      id: string
      metadata?: { branchGroupId?: string; branchIndex?: number }
    }>
    const tagged = merged.find((m) => m.id === "a-1")
    expect(tagged?.metadata?.branchGroupId).toBe("u-1")
    expect(tagged?.metadata?.branchIndex).toBe(0)

    // sendPrompt fires for the new assistant turn — sendPromptMock has been
    // called (via `send()`), which means we did re-issue the request.
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("non-Tauri: skips the message subscription", async () => {
    isTauriMock.mockReturnValue(false)
    renderHook(() => useClaudeChat())
    await flush()
    expect(onClaudeMessageMock).not.toHaveBeenCalled()
  })

  // ── handleEvent paths (driven through the sidecar message subscription) ──

  it("incoming sdk_session_id event persists the SDK conversation id", async () => {
    renderHook(() => useClaudeChat())
    await flush()
    expect(_messageCallback).toBeTruthy()
    await act(async () => {
      _messageCallback?.({
        type: "sdk_session_id",
        sessionId: "sess-1",
        sdkSessionId: "sdk-abc",
      })
    })
    expect(setSdkSessionIdMock).toHaveBeenCalledWith("sess-1", "sdk-abc")
  })

  it("incoming session_ended (no error) flips status to idle", async () => {
    renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      _messageCallback?.({ type: "session_ended", sessionId: "sess-1" })
    })
    expect(chatState.setStatus).toHaveBeenCalledWith("idle")
  })

  it("incoming permission_request for an already-allowed tool auto-approves", async () => {
    settingsState.settings.alwaysAllowTools = ["read"]
    renderHook(() => useClaudeChat())
    await flush()
    // Mirror the subscriber-driven allow-list refresh that happens on mount.
    settingsSubscribers.forEach((sub) => sub(settingsState))
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-1",
        toolUseID: "tu-1",
        toolName: "read",
        input: {},
      })
    })
    expect(approveToolMock).toHaveBeenCalledWith("sess-1", "req-1", "allow")
    settingsState.settings.alwaysAllowTools = []
  })

  it("Auto-mode auto-approves a safe shell command without prompting", async () => {
    ;(settingsState.settings as Record<string, unknown>).agentPermissions = {
      autoApprove: { enabled: true },
    }
    renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-auto-allow",
        toolUseID: "tu-a",
        toolName: "Bash",
        input: { command: "git status" },
      })
    })
    expect(approveToolMock).toHaveBeenCalledWith("sess-1", "req-auto-allow", "allow")
    delete (settingsState.settings as Record<string, unknown>).agentPermissions
  })

  it("Auto-mode auto-denies a catastrophic shell command", async () => {
    ;(settingsState.settings as Record<string, unknown>).agentPermissions = {
      autoApprove: { enabled: true },
    }
    renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-auto-deny",
        toolUseID: "tu-d",
        toolName: "Bash",
        input: { command: "rm -rf /" },
      })
    })
    expect(approveToolMock).toHaveBeenCalledWith(
      "sess-1",
      "req-auto-deny",
      "deny",
      expect.stringContaining("auto-denied")
    )
    delete (settingsState.settings as Record<string, unknown>).agentPermissions
  })

  it("incoming permission_request for a non-active session is auto-denied", async () => {
    chatState.activeSessionId = "sess-other"
    renderHook(() => useClaudeChat())
    await flush()
    // Push the active-session change through the subscriber callback so
    // the hook's `activeRef` reflects it without re-rendering.
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-2",
        toolUseID: "tu-2",
        toolName: "write",
        input: {},
      })
    })
    expect(approveToolMock).toHaveBeenCalledWith(
      "sess-1",
      "req-2",
      "deny",
      expect.stringContaining("auto-denied")
    )
    chatState.activeSessionId = "sess-1"
  })

  it("permission_request for a non-active but remotely-attached session is not auto-denied", async () => {
    const registry = await import("@/lib/companion/remote-attach-registry")
    registry.__resetRemoteAttachForTests()
    registry.attachSession("sess-1", "dev-remote")

    chatState.activeSessionId = "sess-other"
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-remote",
        toolUseID: "tu-r",
        toolName: "write",
        input: {},
      })
    })
    // Routed to the remote device — no auto-deny, and a backstop is armed.
    expect(approveToolMock).not.toHaveBeenCalled()
    expect(registry.hasArmedBackstop("sess-1")).toBe(true)

    registry.__resetRemoteAttachForTests()
    chatState.activeSessionId = "sess-1"
  })

  it("incoming permission_request for the active session pushes an approval", async () => {
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-3",
        toolUseID: "tu-3",
        toolName: "edit",
        input: { path: "x.ts" },
      })
    })
    expect(chatState.pushApproval).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", requestId: "req-3", toolName: "edit" })
    )
  })
})

describe("useClaudeChat — native vector backend branch", () => {
  const mockNativeStore = { provider: "native" }

  beforeEach(() => {
    mockGetTwinRuntimeSettings.mockResolvedValue({
      workerEnabled: true,
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "sk-test",
      },
      storage: {
        vectorBackend: "native",
      },
    })
    mockCreateVectorStore.mockReturnValue(mockNativeStore)
  })

  it("case 'native' builds a storeConfig with provider=native and calls createVectorStore", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello from native")
    })

    expect(mockCreateVectorStore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "native",
        native: {},
        embeddingConfig: expect.objectContaining({ provider: "openai" }),
      })
    )
  })
})

describe("useClaudeChat — goal loop wiring (ADR-0019)", () => {
  const adapterMock = jest.requireMock("@/lib/claude/adapter") as {
    applySdkEvent: jest.Mock
    extractUsage: jest.Mock
  }

  beforeEach(() => {
    // `recordResultUsage` (real module) also calls the mocked extractUsage, so
    // reset it here to the no-usage default for deterministic per-test setup.
    adapterMock.extractUsage.mockReset().mockReturnValue(null)
  })

  function activeGoal(over: Record<string, unknown> = {}) {
    return { id: "g1", status: "active", generationId: "gen1", config: {}, ...over }
  }

  /** Drive a synthetic `event` whose applySdkEvent result seals the turn. */
  async function driveTurnComplete(
    result: unknown = { usage: { input_tokens: 1, output_tokens: 1 } }
  ) {
    adapterMock.applySdkEvent.mockReturnValueOnce({
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "draft" }] }],
      turnComplete: true,
      result,
    })
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "result" } })
    })
    await flush()
    await flush()
  }

  it("send pauses an active goal on a fresh user message", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal())
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("steer this way")
    })
    expect(goalRuntimeMock.pauseGoal).toHaveBeenCalledWith("g1")
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("send does NOT pause on a silent continuation (skipUserAppend)", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal())
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("keep going", undefined, { skipUserAppend: true })
    })
    expect(goalRuntimeMock.pauseGoal).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("send does NOT pause when there is no active goal", async () => {
    // default getActiveGoalForSession → undefined
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(goalRuntimeMock.pauseGoal).not.toHaveBeenCalled()
  })

  it("turnComplete + continue dispatches a silent continuation", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal())
    buildGoalJudgeClientMock.mockReturnValue({ complete: jest.fn() })
    handleTurnCompleteMock.mockResolvedValue({ kind: "continue", userMessage: "go on" })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(handleTurnCompleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: "g1", capturedGenerationId: "gen1" })
    )
    // The continuation routes back through send → sendPrompt with the text.
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "go on", expect.any(Object))
    // Plugin bus: the SDK turn sealed → MESSAGE_RECEIVED + AGENT_COMPLETED.
    expect(busEmitMock).toHaveBeenCalledWith(BusEvents.MESSAGE_RECEIVED, { sessionId: "sess-1" })
    expect(busEmitMock).toHaveBeenCalledWith(BusEvents.AGENT_COMPLETED, { sessionId: "sess-1" })
  })

  it("turnComplete computes tokensDelta from result usage", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal({ id: "g-tok" }))
    buildGoalJudgeClientMock.mockReturnValue({ complete: jest.fn() })
    handleTurnCompleteMock.mockResolvedValue({ kind: "stale", reason: "x" })
    // Persistent (not Once): `recordResultUsage` consumes one call before the
    // goal block reads it, so both calls must see the same usage.
    adapterMock.extractUsage.mockReturnValue({ inputTokens: 10, outputTokens: 5 })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(handleTurnCompleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ tokensDelta: 15 })
    )
  })

  it("turnComplete + exit appends a system card and does not continue", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal({ id: "g-exit" }))
    buildGoalJudgeClientMock.mockReturnValue({ complete: jest.fn() })
    handleTurnCompleteMock.mockResolvedValue({
      kind: "exit",
      exit: "judge_done",
      resultingStatus: "completed",
      reason: "objective satisfied",
    })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(chatState.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        parts: [expect.objectContaining({ text: expect.stringContaining("Goal completed") })],
      })
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("turnComplete with no judge client warns once and pauses", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal({ id: "g-nojudge" }))
    buildGoalJudgeClientMock.mockReturnValue(null)
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(handleTurnCompleteMock).not.toHaveBeenCalled()
    expect(goalRuntimeMock.pauseGoal).toHaveBeenCalledWith("g-nojudge")
    expect(chatState.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [expect.objectContaining({ text: expect.stringContaining("no judge model") })],
      })
    )
  })

  it("turnComplete + stale outcome is a no-op (no card, no continuation)", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal({ id: "g-stale" }))
    buildGoalJudgeClientMock.mockReturnValue({ complete: jest.fn() })
    handleTurnCompleteMock.mockResolvedValue({ kind: "stale", reason: "rotated" })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(chatState.appendMessage).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  // ── /loop wiring (self-paced) ──────────────────────────────────────────────

  function activeLoop(over: Record<string, unknown> = {}) {
    return {
      id: "lp1",
      sessionId: "sess-1",
      mode: "self_paced",
      status: "active",
      generationId: "lgen1",
      config: {
        maxIterations: 100,
        maxTokens: 1_000_000,
        minDelayMs: 60_000,
        maxDelayMs: 3_600_000,
        maxParseFailures: 3,
      },
      iterations: 0,
      tokensUsed: 0,
      parseFailureCount: 0,
      ...over,
    }
  }

  it("send pauses an active self-paced loop on a fresh user message", async () => {
    loopRuntimeMock.getActiveLoopForSession.mockResolvedValue(activeLoop())
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("steer this way")
    })
    expect(loopRuntimeMock.pauseLoop).toHaveBeenCalledWith("lp1")
  })

  it("send does NOT pause an interval loop (scheduler-driven)", async () => {
    loopRuntimeMock.getActiveLoopForSession.mockResolvedValue(activeLoop({ mode: "interval" }))
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("just chatting")
    })
    expect(loopRuntimeMock.pauseLoop).not.toHaveBeenCalled()
  })

  it("turnComplete drives the self-paced loop and dispatches the continuation", async () => {
    loopRuntimeMock.getActiveLoopForSession.mockResolvedValue(activeLoop())
    handleLoopTurnCompleteMock.mockResolvedValue({
      kind: "continue",
      userMessage: "loop iteration 2",
      delayMs: 0,
    })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(handleLoopTurnCompleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ loopId: "lp1", capturedGenerationId: "lgen1" })
    )
    // gateLoopContinuation has no baseline (lastIterationAt undefined) → send.
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "loop iteration 2", expect.any(Object))
  })

  it("turnComplete + loop exit appends the loop card and stops", async () => {
    loopRuntimeMock.getActiveLoopForSession.mockResolvedValue(activeLoop({ id: "lp-exit" }))
    handleLoopTurnCompleteMock.mockResolvedValue({
      kind: "exit",
      exit: "completed",
      resultingStatus: "completed",
      reason: "report delivered",
    })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(chatState.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        parts: [expect.objectContaining({ text: expect.stringContaining("Loop completed") })],
      })
    )
  })

  it("the kickoff listener dispatches iteration 1 silently for the active session", async () => {
    let kickoff: ((loop: unknown) => void) | null = null
    loopRuntimeMock.onKickoff.mockImplementation((cb: (loop: unknown) => void) => {
      kickoff = cb
      return () => {}
    })
    renderHook(() => useClaudeChat())
    await flush()
    expect(kickoff).not.toBeNull()
    await act(async () => {
      kickoff?.(activeLoop({ safePrompt: "do the thing" }))
    })
    await flush()
    expect(sendPromptMock).toHaveBeenCalledWith(
      "sess-1",
      expect.stringContaining("[Loop iteration 1 of 100]"),
      expect.any(Object)
    )
  })

  it("the kickoff listener ignores loops for other sessions", async () => {
    let kickoff: ((loop: unknown) => void) | null = null
    loopRuntimeMock.onKickoff.mockImplementation((cb: (loop: unknown) => void) => {
      kickoff = cb
      return () => {}
    })
    renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      kickoff?.(activeLoop({ sessionId: "sess-other", safePrompt: "x" }))
    })
    await flush()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })
})

describe("useClaudeChat — agent-trace wiring (Phase B4)", () => {
  it("send() injects traceId + spanId into the SendOptions echoed to the sidecar", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(sendPromptMock).toHaveBeenCalled()
    const call = sendPromptMock.mock.calls.at(-1) as [string, unknown, Record<string, unknown>]
    const options = call[2]
    expect(typeof options.traceId).toBe("string")
    expect(typeof options.spanId).toBe("string")
    expect(String(options.traceId)).toMatch(/^[0-9a-f]{32}$/)
    expect(String(options.spanId)).toMatch(/^[0-9a-f]{16}$/)
  })

  it("setLastSend caches the trace identifiers so session_ended can finalise the span", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(chatState.setLastSend).toHaveBeenCalled()
    const lastCall = chatState.setLastSend.mock.calls.at(-1) as [
      string,
      { options: Record<string, unknown> },
    ]
    expect(typeof lastCall[1].options.spanId).toBe("string")
    expect(typeof lastCall[1].options.traceId).toBe("string")
  })

  it("preserves a caller-provided spanId instead of generating a new one", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi", {
        spanId: "1111222233334444",
        traceId: "deadbeefdeadbeefdeadbeefdeadbeef",
      } as never)
    })
    const call = sendPromptMock.mock.calls.at(-1) as [string, unknown, Record<string, unknown>]
    expect(call[2].spanId).toBe("1111222233334444")
    expect(call[2].traceId).toBe("deadbeefdeadbeefdeadbeefdeadbeef")
  })

  it("ends the span with errorType when send() throws before the sidecar gets the call", async () => {
    const { setAgentTraceWriter, __resetAgentTraceEmitterForTesting } =
      await import("@/lib/agent-trace/emitter")
    const captured: Array<Record<string, unknown>> = []
    __resetAgentTraceEmitterForTesting()
    setAgentTraceWriter((s) => {
      captured.push(s as unknown as Record<string, unknown>)
    })
    sendPromptMock.mockRejectedValueOnce(new Error("network down"))

    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("ping")
    })
    expect(captured).toHaveLength(1)
    expect(captured[0].errorType).toBe("send_failed")
    expect(captured[0].errorMessage).toBe("network down")
    setAgentTraceWriter(null)
  })
})
