/**
 * @jest-environment jsdom
 *
 * Coverage focus: the deterministic action surface of `useClaudeChat`.
 * The hook also wires a long-lived sidecar event handler through `onClaudeMessage`
 * — that handler is exercised indirectly via `send` / `respondToApproval`.
 */
import { act, renderHook } from "@testing-library/react"

import { useAgentRuntimeStore, useExternalAgentStore } from "@/stores/agent"

const mockTrackEvent = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

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
// Live mid-turn steer into the Anthropic sidecar's streaming input. Rejecting
// is the realistic default for most tests: an idle/closed query refuses, and
// `send` must then fall back to the durable queue.
const steerSessionMock = jest.fn().mockRejectedValue(new Error("input_closed"))
const closeSessionIpcMock = jest.fn().mockResolvedValue(undefined)
const approveToolMock = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/claude/ipc", () => ({
  approveTool: (...a: unknown[]) => approveToolMock(...a),
  closeSession: (id: string) => closeSessionIpcMock(id),
  interruptSession: (id: string) => interruptSessionMock(id),
  onClaudeMessage: (cb: (evt: unknown) => void) => onClaudeMessageMock(cb),
  sendPrompt: (...a: unknown[]) => sendPromptMock(...a),
  steerSession: (...a: unknown[]) => steerSessionMock(...a),
}))

// Standalone (BYOK) chat — off by default so the sidecar-path suite is
// unaffected; individual tests flip the flag.
const standaloneFlag = { value: false }
const runStandaloneTurnMock = jest.fn(async (_args?: unknown): Promise<void> => undefined)
const gateWorkbenchProviderPayloadMock = jest.fn((payload: unknown) => payload)
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: () => standaloneFlag.value,
}))
jest.mock("@/lib/ai/chat/standalone-engine", () => ({
  runStandaloneTurn: (args: { emit: (e: unknown) => void; signal: AbortSignal }) =>
    runStandaloneTurnMock(args),
}))
jest.mock("@/lib/context-workbench/provider-payload", () => ({
  gateWorkbenchProviderPayload: (
    payload: { content: unknown; sendOptions: unknown; messages: unknown[] },
    resourceContext: string
  ) =>
    gateWorkbenchProviderPayloadMock({
      ...payload,
      content: resourceContext
        ? `[Current resource context]\n${resourceContext}\n\n[User instruction]\n${String(payload.content)}`
        : payload.content,
    }),
}))

jest.mock("@/lib/claude/adapter", () => ({
  applySdkEvent: jest.fn(() => ({ messages: [], turnComplete: false })),
  contentPreview: (c: unknown) => (typeof c === "string" ? c : "preview"),
  makeUserMessage: jest.fn((c: unknown) => ({
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: c }],
  })),
  extractUsage: jest.fn(() => null),
  mergeTwinSourcesIntoLastAssistant: (msgs: unknown) => msgs,
}))

const runTurnMemoryMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/memory/run-turn-memory", () => ({
  runTurnMemory: (...args: unknown[]) => runTurnMemoryMock(...args),
}))

const applySdkSubagentBridgeMock = jest.fn()
jest.mock("@/lib/claude/sdk-subagent-bridge", () => ({
  applySdkSubagentBridge: (...args: unknown[]) => applySdkSubagentBridgeMock(...args),
  __resetSdkSubagentBridge: () => {},
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
  persistStreamingMessages: (...a: unknown[]) => persistMessagesMock(...a),
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

const flushProjectEditorEdits = jest.fn<Promise<string[]>, []>()
const toastWarning = jest.fn()
jest.mock("@/lib/files/project-editor-bridge", () => ({
  flushProjectEditorEdits: () => flushProjectEditorEdits(),
}))
jest.mock("sonner", () => ({ toast: { warning: (msg: string) => toastWarning(msg) } }))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({ model: "sonnet", systemPrompt: "sys" })),
}))

const dispatchUserPromptSubmitMock = jest.fn(async () => ({ action: "proceed" as const }))
const dispatchChatErrorMock = jest.fn()
const dispatchTokenUsageMock = jest.fn()
const dispatchPostChatReceiveMock = jest.fn(async () => ({}))
jest.mock("@/lib/claude/adapter-hooks", () => ({
  dispatchUserPromptSubmit: (...a: unknown[]) => dispatchUserPromptSubmitMock(...(a as [])),
  dispatchChatError: (...a: unknown[]) => dispatchChatErrorMock(...(a as [])),
  dispatchTokenUsage: (...a: unknown[]) => dispatchTokenUsageMock(...(a as [])),
  dispatchPostChatReceive: (...a: unknown[]) => dispatchPostChatReceiveMock(...(a as [])),
  // W3.1 tool hooks — inert in this unit suite (integration coverage lives in
  // chat-main-flow.integration.test.tsx).
  dispatchPreToolUse: jest.fn(async () => ({ action: "allow" as const })),
  dispatchPostToolUse: jest.fn(async () => ({})),
  dispatchOnMessageSend: jest.fn(async (m: unknown) => m),
  dispatchOnAssistantMessage: jest.fn(async (m: unknown) => m),
  hasPostToolUseListeners: jest.fn(() => false),
}))

// External-agent branch (D1): dynamically imported by `send` when the agent
// runtime is "external". Mock both so the branch is drivable from a test.
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

interface SliceLike {
  messages: unknown[]
  status: string
  errorMessage: string | null
  errorDiagnostic: { message?: string } | null
  pendingApprovals: unknown[]
  activeBranchByGroup: Record<string, string>
}
const makeSlice = (): SliceLike => ({
  messages: [],
  status: "idle",
  errorMessage: null,
  errorDiagnostic: null,
  pendingApprovals: [],
  activeBranchByGroup: {},
})

interface ChatStateLike {
  activeSessionId: string | null
  openSessionIds: string[]
  splitSessionId: string | null
  /** Slices for *background* (non-focused) sessions; the active session's slice
   * is projected from the flat fields below by the `sessions` getter, so the
   * existing flat-field test seeds (`chatState.messages = …`) keep working. */
  otherSlices: Record<string, SliceLike>
  readonly sessions: Record<string, SliceLike>
  messages: unknown[]
  status: string
  errorMessage: string | null
  errorDiagnostic: { message?: string } | null
  pendingApprovals: unknown[]
  activeBranchByGroup: Record<string, string>
  pendingCommandOverrides: unknown
  referencedPaths: unknown[]
  ephemeralSkillIds: string[]
  lastSendBySession: Record<string, unknown>
  setActiveSession: jest.Mock
  setMessages: jest.Mock
  replaceMessages: jest.Mock
  appendMessage: jest.Mock
  setStatus: jest.Mock
  setError: jest.Mock
  replaceSessionMessages: jest.Mock
  setSessionStatus: jest.Mock
  setSessionError: jest.Mock
  setSessionDiagnostic: jest.Mock
  setSessionActiveBranch: jest.Mock
  pushApproval: jest.Mock
  clearApproval: jest.Mock
  markApprovalInterrupted: jest.Mock
  closeSession: jest.Mock
  setPendingCommandOverrides: jest.Mock
  clearEphemeralSkillIds: jest.Mock
  setLastSend: jest.Mock
  clearLastSend: jest.Mock
  enqueueSteer: jest.Mock
  clearSteerQueue: jest.Mock
}

const sliceWrite = (id: string, patch: Partial<SliceLike>) => {
  if (id === chatState.activeSessionId) {
    if (patch.messages !== undefined) chatState.messages = patch.messages
    if (patch.status !== undefined) chatState.status = patch.status
    if (patch.errorMessage !== undefined) chatState.errorMessage = patch.errorMessage
    if (patch.pendingApprovals !== undefined) chatState.pendingApprovals = patch.pendingApprovals
    if (patch.activeBranchByGroup !== undefined)
      chatState.activeBranchByGroup = patch.activeBranchByGroup
    return
  }
  chatState.otherSlices[id] = { ...(chatState.otherSlices[id] ?? makeSlice()), ...patch }
}

const chatState: ChatStateLike = {
  activeSessionId: "sess-1",
  openSessionIds: ["sess-1"],
  splitSessionId: null,
  otherSlices: {},
  get sessions() {
    const map: Record<string, SliceLike> = { ...chatState.otherSlices }
    if (chatState.activeSessionId) {
      map[chatState.activeSessionId] = {
        messages: chatState.messages,
        status: chatState.status,
        errorMessage: chatState.errorMessage,
        errorDiagnostic: chatState.errorDiagnostic,
        pendingApprovals: chatState.pendingApprovals,
        activeBranchByGroup: chatState.activeBranchByGroup,
      }
    }
    return map
  },
  messages: [],
  status: "idle",
  errorMessage: null,
  errorDiagnostic: null,
  pendingApprovals: [],
  activeBranchByGroup: {},
  pendingCommandOverrides: null,
  referencedPaths: [],
  ephemeralSkillIds: [],
  lastSendBySession: {},
  setActiveSession: jest.fn(),
  setMessages: jest.fn(),
  replaceMessages: jest.fn((m: unknown[]) => {
    chatState.messages = m
  }),
  appendMessage: jest.fn((msg: unknown) => {
    chatState.messages = [...chatState.messages, msg]
  }),
  setStatus: jest.fn((s: string) => {
    chatState.status = s
  }),
  setError: jest.fn((e: string | null) => {
    chatState.errorMessage = e
    chatState.status = e ? "error" : "idle"
  }),
  replaceSessionMessages: jest.fn((id: string, m: unknown[]) => sliceWrite(id, { messages: m })),
  setSessionStatus: jest.fn((id: string, s: string) => sliceWrite(id, { status: s })),
  setSessionError: jest.fn((id: string, e: string | null) =>
    sliceWrite(id, { errorMessage: e, errorDiagnostic: null, status: e ? "error" : "idle" })
  ),
  // Mirrors the real store: the structured write also lands the raw technical
  // text on the legacy field.
  setSessionDiagnostic: jest.fn((id: string, d: { message?: string } | null) =>
    sliceWrite(id, {
      errorDiagnostic: d,
      errorMessage: d?.message ?? null,
      status: d ? "error" : "idle",
    })
  ),
  setSessionActiveBranch: jest.fn((id: string, g: string, mid: string) => {
    const cur = chatState.sessions[id]?.activeBranchByGroup ?? {}
    sliceWrite(id, { activeBranchByGroup: { ...cur, [g]: mid } })
  }),
  pushApproval: jest.fn((a: { sessionId: string }) => {
    const cur = chatState.sessions[a.sessionId]?.pendingApprovals ?? []
    sliceWrite(a.sessionId, { pendingApprovals: [...cur, a], status: "awaiting_approval" })
  }),
  clearApproval: jest.fn(),
  markApprovalInterrupted: jest.fn(),
  closeSession: jest.fn(),
  setPendingCommandOverrides: jest.fn((o: unknown) => {
    chatState.pendingCommandOverrides = o
  }),
  clearEphemeralSkillIds: jest.fn(() => {
    chatState.ephemeralSkillIds = []
  }),
  setLastSend: jest.fn((id: string, e: unknown) => {
    chatState.lastSendBySession[id] = e
  }),
  clearLastSend: jest.fn((id: string) => {
    delete chatState.lastSendBySession[id]
  }),
  enqueueSteer: jest.fn(),
  clearSteerQueue: jest.fn(),
}

const subscribers: Array<(s: ChatStateLike) => void> = []
const selectIsAtStreamCapMock = jest.fn((_s: unknown, _id: string) => false)

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
  selectIsAtStreamCap: (s: unknown, id: string) => selectIsAtStreamCapMock(s, id),
}))

// The unified execution broker governs the concurrency cap; stub it so a test
// can flip the session at/over capacity without standing up the real broker.
const isAtCapacityMock = jest.fn((_resource: string, _id?: string) => false)
jest.mock("@/lib/execution/broker", () => ({
  getExecutionBroker: () => ({
    isAtCapacity: (resource: string, id?: string) => isAtCapacityMock(resource, id),
  }),
}))
// Chat admission is exercised in lib/execution/chat-lease.test.ts; here it is a
// no-op so the hook's send path stays isolated from the real broker.
const acquireChatLeaseMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/execution/chat-lease", () => ({
  acquireChatLease: (...args: unknown[]) => acquireChatLeaseMock(...args),
}))

const settingsState = {
  settings: {
    alwaysAllowTools: [] as string[],
    artifacts: { autoCreate: false },
    agentPermissions: undefined as { toolRules?: Record<string, unknown> } | undefined,
  },
  toggleAlwaysAllow: jest.fn().mockResolvedValue(undefined),
  save: jest.fn().mockResolvedValue(undefined),
}
const settingsSubscribers: Array<(s: typeof settingsState) => void> = []

// The background utility client is irrelevant to these tests (Auto-mode uses
// the deterministic rules tier without it); stub it to null so no real
// provider resolution runs.
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: () => null,
}))
// Wrap the real Auto-mode runner so most tests keep its deterministic rules
// tier, while one test can override it to a never-resolving promise (a wedged
// model judge) and assert the renderer's timeout still surfaces the dialog.
jest.mock("@/lib/claude/permissions/auto-mode-runner", () => {
  const actual = jest.requireActual("@/lib/claude/permissions/auto-mode-runner")
  return { ...actual, runAutoModeForTool: jest.fn(actual.runAutoModeForTool) }
})
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
jest.mock("@cognia/vector/store", () => ({
  createVectorStore: (...args: unknown[]) => mockCreateVectorStore(...args),
}))

import { useClaudeChat } from "./use-claude-chat"

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(true)
  flushProjectEditorEdits.mockReset().mockResolvedValue([])
  toastWarning.mockReset()
  _messageCallback = null
  busEmitMock.mockClear()
  onClaudeMessageMock.mockClear()
  onClaudeUnsub.mockClear()
  sendPromptMock.mockReset().mockResolvedValue(undefined)
  interruptSessionMock.mockReset().mockResolvedValue(undefined)
  standaloneFlag.value = false
  runStandaloneTurnMock.mockReset().mockResolvedValue(undefined)
  gateWorkbenchProviderPayloadMock.mockClear()
  runTurnMemoryMock.mockReset().mockResolvedValue(undefined)
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
  chatState.openSessionIds = ["sess-1"]
  chatState.splitSessionId = null
  chatState.otherSlices = {}
  chatState.messages = []
  chatState.status = "idle"
  chatState.errorMessage = null
  chatState.pendingApprovals = []
  chatState.activeBranchByGroup = {}
  chatState.pendingCommandOverrides = null
  chatState.referencedPaths = []
  chatState.ephemeralSkillIds = []
  chatState.lastSendBySession = {}
  chatState.setActiveSession.mockClear()
  chatState.setMessages.mockClear()
  chatState.replaceMessages.mockClear()
  chatState.appendMessage.mockClear()
  chatState.setStatus.mockClear()
  chatState.setError.mockClear()
  chatState.replaceSessionMessages.mockClear()
  steerSessionMock.mockClear().mockRejectedValue(new Error("input_closed"))
  chatState.setSessionStatus.mockClear()
  chatState.setSessionError.mockClear()
  chatState.setSessionDiagnostic.mockClear()
  chatState.setSessionActiveBranch.mockClear()
  chatState.pushApproval.mockClear()
  chatState.clearApproval.mockClear()
  chatState.closeSession.mockClear()
  chatState.setPendingCommandOverrides.mockClear()
  chatState.clearEphemeralSkillIds.mockClear()
  selectIsAtStreamCapMock.mockReset().mockReturnValue(false)
  isAtCapacityMock.mockReset().mockReturnValue(false)
  acquireChatLeaseMock.mockReset().mockResolvedValue(undefined)
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
  mockTrackEvent.mockClear()
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

  it("records message submission before the provider settles", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
    })

    expect(mockTrackEvent).toHaveBeenCalledWith("chat.message.sent", {
      sessionId: "sess-1",
      provider: "anthropic",
      surface: "chat",
    })
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

  it("preserves attachment provenance on the optimistic user message", async () => {
    const { makeUserMessage } = jest.requireMock("@/lib/claude/adapter") as {
      makeUserMessage: jest.Mock
    }
    const manifest = [{ filename: "notes.txt", mediaType: "text/plain", kind: "document" as const }]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", undefined, { attachmentManifest: manifest })
    })
    expect(makeUserMessage).toHaveBeenCalledWith("hello", undefined, manifest)
  })

  it("send() routes through the standalone engine (not the sidecar) in BYOK mode", async () => {
    standaloneFlag.value = true
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(runStandaloneTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", emit: expect.any(Function) })
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("gates the fully assembled payload for embedded resource sessions", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Embedded",
      kind: "resource-workbench",
      visibility: "embedded",
      model: "sonnet",
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send("sensitive context")
    })

    expect(gateWorkbenchProviderPayloadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "sensitive context",
        sendOptions: expect.any(Object),
        messages: expect.any(Array),
      })
    )
  })

  it("keeps private resource context out of plugin hooks and persisted user messages", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Embedded",
      kind: "resource-workbench",
      visibility: "embedded",
      model: "sonnet",
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send("fix this", undefined, {
        sessionId: "sess-1",
        resourceContext: "private@example.com",
      })
    })

    expect(dispatchUserPromptSubmitMock).toHaveBeenCalledWith(
      "fix this",
      "sess-1",
      expect.any(Object)
    )
    expect(gateWorkbenchProviderPayloadMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("private@example.com") })
    )
    expect(sendPromptMock).toHaveBeenCalledWith(
      "sess-1",
      expect.stringContaining("private@example.com"),
      expect.any(Object)
    )
    const persistedMessages = persistMessagesMock.mock.calls.at(-1)?.[1]
    expect(JSON.stringify(persistedMessages)).toContain("fix this")
    expect(JSON.stringify(persistedMessages)).not.toContain("private@example.com")
  })

  it("stop() aborts the standalone turn instead of interrupting the sidecar", async () => {
    standaloneFlag.value = true
    let captured: { signal: AbortSignal } | null = null
    runStandaloneTurnMock.mockImplementation(async (args?: unknown) => {
      captured = args as { signal: AbortSignal }
      await new Promise(() => {}) // never resolves — stays "in flight"
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      void result.current.send("hello")
    })
    await act(async () => {
      await result.current.stop("sess-1")
    })
    expect(captured).not.toBeNull()
    expect(captured!.signal.aborted).toBe(true)
    expect(interruptSessionMock).not.toHaveBeenCalled()
  })

  it("external-agent writes stream into the sender's own slice across a mid-run focus switch (D1)", async () => {
    // Concurrent-chat behavior: a focus switch mid-run must NOT redirect or
    // drop the in-flight external turn — every write targets the *sender's*
    // session slice (sess-1) regardless of which session is now focused.
    useAgentRuntimeStore.setState({ runtime: "external", externalAgentId: "ext-1" })
    chatState.activeSessionId = "sess-1"
    executeOnExternalAgentMock.mockImplementation(
      async (_text: string, opts: { onEvent: (e: unknown) => void }) => {
        opts.onEvent({ type: "text", text: "a" })
        // User switches focus away mid-run.
        chatState.activeSessionId = "sess-other"
        subscribers.forEach((sub) => sub(chatState))
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
    // Every assistant write is session-scoped to sess-1 (never the now-focused
    // sess-other), so the background pane keeps streaming.
    const targets = chatState.replaceSessionMessages.mock.calls.map((c) => c[0])
    expect(targets.length).toBeGreaterThanOrEqual(2)
    expect(targets.every((id) => id === "sess-1")).toBe(true)
    // Persist targets THIS session id.
    expect(persistMessagesMock).toHaveBeenCalledWith("sess-1", expect.any(Array))
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.completed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "external",
        surface: "chat",
      })
    )
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
      await result.current.send("refactor this module", {
        additionalDirectories: ["/shared"],
      })
    })
    expect(setDelegationRulesMock).toHaveBeenCalled()
    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "refactor this module",
      expect.objectContaining({
        agentId: "ext-1",
        context: { custom: { additionalDirectories: ["/shared"] } },
      })
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
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      // Strict policy: the external-agent turn is NOT re-issued on the built-in
      // path, so the diagnostic is attributed to the agent that actually failed.
      expect.objectContaining({
        message: "spawn failed",
        source: "external-agent",
        meta: expect.objectContaining({ agentId: "ext-1" }),
      })
    )
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.failed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "external",
        surface: "chat",
        errorType: "ExternalAgentError",
      })
    )
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("spawn failed")
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
    expect(chatState.setError).toHaveBeenCalledWith(
      "No conversation is open. Start a new one to send this."
    )
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
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ code: "promptBlockedByPlugin", message: "policy violation" })
    )
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
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ message: "network down", source: "chat" })
    )
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
    expect(chatState.clearApproval).toHaveBeenCalledWith("r-1", "sess-1")
  })

  it("respondToApproval resolves builtin-skill: approvals locally, never via approveTool", async () => {
    const { resolveApproval, awaitApproval } =
      await import("@/lib/connectors/hitl/approval-registry")
    void resolveApproval
    const pending = awaitApproval("sess-1", "builtin-skill:im.create_chat:x", { ttlMs: 0 })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "builtin-skill:im.create_chat:x",
          toolName: "im_create_chat",
        } as never,
        "allow"
      )
    })
    // Resolved in-renderer: the pending registry promise settles, the card is
    // cleared, and the sidecar approveTool IPC is never touched.
    await expect(pending).resolves.toEqual({ decision: "allow" })
    expect(approveToolMock).not.toHaveBeenCalled()
    expect(chatState.clearApproval).toHaveBeenCalledWith("builtin-skill:im.create_chat:x", "sess-1")
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

  it("respondToApproval (allow_always) persists a TARGET-SCOPED rule when a target exists", async () => {
    settingsState.save.mockClear()
    settingsState.toggleAlwaysAllow.mockClear()
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "r-1",
          toolName: "Bash",
          input: { command: "git status" },
        } as never,
        "allow_always"
      )
    })
    // Scoped rule persisted; the coarse name-grant path is NOT taken.
    expect(settingsState.save).toHaveBeenCalledWith({
      agentPermissions: { toolRules: { Bash: { "git *": "allow" } } },
    })
    expect(settingsState.toggleAlwaysAllow).not.toHaveBeenCalled()
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

  it("incoming session_ended (no error) completes a tool-only turn", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
      _messageCallback?.({ type: "session_ended", sessionId: "sess-1" })
    })
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.completed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "anthropic",
        surface: "chat",
      })
    )
  })

  it("records a permanent provider failure without exporting its message", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
      _messageCallback?.({
        type: "session_ended",
        sessionId: "sess-1",
        error: "private upstream response",
        httpStatus: 429,
      })
    })
    await flush()

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.failed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "anthropic",
        surface: "chat",
        errorType: "http_429",
      })
    )
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("private upstream response")
  })

  it("classifies a permanent provider failure without an HTTP status", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
      _messageCallback?.({
        type: "session_ended",
        sessionId: "sess-1",
        error: "private upstream response",
      })
    })
    await flush()

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.failed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "anthropic",
        surface: "chat",
        errorType: "provider_error",
      })
    )
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("private upstream response")
  })

  it("sidecar_exited settles a streaming session with a retryable error", async () => {
    chatState.status = "idle"
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
      chatState.status = "streaming"
      _messageCallback?.({ type: "sidecar_exited" })
    })
    // The sidecar crash now emits a code, not a sentinel string the view has
    // to compare back — that round-trip existed only because the store could
    // not carry structure.
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ code: "sidecarExited", source: "chat", retryable: true })
    )
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.failed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "anthropic",
        surface: "chat",
        errorType: "sidecar_exited",
      })
    )
    chatState.status = "idle"
  })

  it("sidecar_exited interrupts a pending approval and does not touch idle sessions", async () => {
    chatState.status = "awaiting_approval"
    chatState.pendingApprovals = [{ requestId: "req-9", sessionId: "sess-1" }]
    renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      _messageCallback?.({ type: "sidecar_exited" })
    })
    expect(chatState.markApprovalInterrupted).toHaveBeenCalledWith(
      "req-9",
      "sess-1",
      expect.any(String)
    )
    // The sidecar crash now emits a code, not a sentinel string the view has
    // to compare back — that round-trip existed only because the store could
    // not carry structure.
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ code: "sidecarExited", source: "chat", retryable: true })
    )
    chatState.status = "idle"
    chatState.pendingApprovals = []
  })

  it("sidecar_exited leaves an idle session untouched", async () => {
    chatState.status = "idle"
    renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      _messageCallback?.({ type: "sidecar_exited" })
    })
    expect(chatState.setSessionDiagnostic).not.toHaveBeenCalled()
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

  it("surfaces the manual approval dialog when the Auto-mode judge hangs (no-dialog hang guard)", async () => {
    const { runAutoModeForTool } = await import("@/lib/claude/permissions/auto-mode-runner")
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    chatState.pushApproval.mockClear()

    // A wedged utility-LLM judge: the Auto-mode decision never settles. Without
    // the renderer timeout this would freeze the turn with no dialog ever shown.
    ;(runAutoModeForTool as jest.Mock).mockReturnValueOnce(new Promise(() => {}))
    jest.useFakeTimers()
    try {
      act(() => {
        _messageCallback?.({
          type: "permission_request",
          sessionId: "sess-1",
          requestId: "req-hang",
          toolUseID: "tu-h",
          toolName: "Bash",
          input: { command: "echo hi" },
        })
      })
      // Let the handler reach the awaited Auto-mode race (still pending).
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(chatState.pushApproval).not.toHaveBeenCalled()

      // After the decision timeout the request falls through to the manual modal.
      act(() => {
        jest.advanceTimersByTime(12_000)
      })
      jest.useRealTimers()
      await flush()
      expect(chatState.pushApproval).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-1", requestId: "req-hang" })
      )
    } finally {
      jest.useRealTimers()
      ;(runAutoModeForTool as jest.Mock).mockReset()
    }
  })

  it("incoming permission_request for a non-open session is auto-denied", async () => {
    chatState.activeSessionId = "sess-other"
    // sess-1 has no open pane → its approval is auto-denied (not surfaced).
    chatState.openSessionIds = ["sess-other"]
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

  it("permission_request for a non-open but remotely-attached session is not auto-denied", async () => {
    const registry = await import("@/lib/companion/remote-attach-registry")
    registry.__resetRemoteAttachForTests()
    registry.attachSession("sess-1", "dev-remote")

    chatState.activeSessionId = "sess-other"
    chatState.openSessionIds = ["sess-other"]
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

  it("records one successful turn outcome at the SDK result boundary", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
    })
    await driveTurnComplete()

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.completed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "anthropic",
        surface: "chat",
      })
    )
    expect(
      mockTrackEvent.mock.calls.filter(([name]) => name === "chat.turn.completed")
    ).toHaveLength(1)
  })

  it("passes the sealed assistant message id to long-term memory extraction", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("remember this")
    })
    await driveTurnComplete()

    expect(runTurnMemoryMock).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ assistantMessageId: "a1" })
    )
  })

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

  it("send while streaming enqueues a steer entry preserving attachments", async () => {
    chatState.status = "streaming"
    const image = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/png", data: "AAAA" },
    }
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send([image, { type: "text", text: "and this" }])
    })
    expect(chatState.enqueueSteer).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ text: "and this", blocks: [image] })
    )
    // Busy-gate returns before dispatch — nothing reaches the sidecar.
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("shows a steer in the transcript immediately, in the user's own words", async () => {
    chatState.status = "streaming"
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("switch to TypeScript")
    })
    const appended = chatState.replaceSessionMessages.mock.calls.at(-1)?.[1] as Array<{
      role: string
      parts: Array<{ type: string; text?: string }>
      metadata?: { steer?: { entryId: string; state: string } }
    }>
    const last = appended.at(-1)
    expect(last?.role).toBe("user")
    // The model-facing "By the way (steering): " framing is added only on the
    // replay payload — never on what the user reads back.
    expect(last?.parts[0]?.text).toBe("switch to TypeScript")
    expect(last?.metadata?.steer?.state).toBe("queued")
    // The bubble's entry id is what ties it to the queue entry.
    expect(last?.metadata?.steer?.entryId).toBe(
      (chatState.enqueueSteer.mock.calls.at(-1)?.[1] as { id: string }).id
    )
  })

  it("delivers a steer live through the Anthropic sidecar and skips the queue", async () => {
    chatState.status = "streaming"
    steerSessionMock.mockResolvedValue({ accepted: true })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("actually use Vitest")
    })
    expect(steerSessionMock).toHaveBeenCalledWith("sess-1", "actually use Vitest")
    // Accepted into the running query — nothing to replay later.
    expect(chatState.enqueueSteer).not.toHaveBeenCalled()
    const appended = chatState.replaceSessionMessages.mock.calls.at(-1)?.[1] as Array<{
      metadata?: { steer?: { state: string } }
    }>
    expect(appended.at(-1)?.metadata?.steer?.state).toBe("accepted")
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("falls back to the queue when the live steer is refused", async () => {
    chatState.status = "streaming"
    steerSessionMock.mockRejectedValue(new Error("input_closed"))
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("and add tests")
    })
    expect(steerSessionMock).toHaveBeenCalled()
    expect(chatState.enqueueSteer).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ text: "and add tests" })
    )
  })

  it("queues a steer while awaiting approval without attempting a live steer", async () => {
    // The composer stays writable during approval on purpose: that is when the
    // user most wants to redirect. The SDK is blocked on the permission
    // round-trip, so there is no live lane to try.
    chatState.status = "awaiting_approval"
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("don't use that tool")
    })
    expect(steerSessionMock).not.toHaveBeenCalled()
    expect(chatState.enqueueSteer).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ text: "don't use that tool" })
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("ignores an empty steer instead of appending a blank bubble", async () => {
    chatState.status = "streaming"
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    chatState.replaceSessionMessages.mockClear()
    await act(async () => {
      await result.current.send("   ")
    })
    expect(chatState.enqueueSteer).not.toHaveBeenCalled()
    expect(chatState.replaceSessionMessages).not.toHaveBeenCalled()
  })

  it("flushSteer is a no-op when the queue is empty", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      result.current.flushSteer("sess-1")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
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
    expect(options.traceparent).toBe(`00-${options.traceId}-${options.spanId}-01`)
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
    expect(call[2].traceparent).toBe("00-deadbeefdeadbeefdeadbeefdeadbeef-1111222233334444-01")
  })

  it("ends the span with errorType when send() throws before the sidecar gets the call", async () => {
    const { setAgentTraceWriter, __resetAgentTraceEmitterForTesting } =
      await import("@cognia/agent-trace/emitter")
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
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.failed",
      expect.objectContaining({
        sessionId: "sess-1",
        surface: "chat",
        errorType: "send_failed",
      })
    )
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("network down")
    setAgentTraceWriter(null)
  })
})

describe("useClaudeChat — concurrent sessions", () => {
  const adapterMock = jest.requireMock("@/lib/claude/adapter") as { applySdkEvent: jest.Mock }

  it("routes streaming events to a background OPEN session's own slice, not the focused one", async () => {
    // Focus sess-other; sess-1 is open in another pane and mid-stream.
    chatState.activeSessionId = "sess-other"
    chatState.openSessionIds = ["sess-other", "sess-1"]
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    adapterMock.applySdkEvent.mockReturnValueOnce({
      // turnComplete commits synchronously (mid-stream deltas are rAF-coalesced
      // and not deterministic under the macrotask-only test flush); the routing
      // code path (isOpen → replaceSessionMessages by id) is identical.
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "bg" }] }],
      turnComplete: true,
    })
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "result" } })
    })
    await flush()
    // The background session streams into its own slice; the focused session's
    // flat projection is never touched.
    expect(chatState.replaceSessionMessages).toHaveBeenCalledWith("sess-1", expect.any(Array))
    expect(chatState.otherSlices["sess-1"]?.messages).toHaveLength(1)
    expect(chatState.messages).toEqual([])
    // Its slice sealed to idle without disturbing the focused session.
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
  })

  it("does NOT touch the store for a closed (no-pane) session — only Dexie", async () => {
    chatState.activeSessionId = "sess-other"
    chatState.openSessionIds = ["sess-other"] // sess-1 has no pane
    listMessagesMock.mockResolvedValue([])
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    adapterMock.applySdkEvent.mockReturnValueOnce({
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "bg" }] }],
      turnComplete: false,
    })
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "delta" } })
    })
    await flush()
    expect(chatState.replaceSessionMessages).not.toHaveBeenCalled()
    expect(persistMessagesMock).toHaveBeenCalledWith("sess-1", expect.any(Array))
  })

  it("feeds every SDK event to the SDK-native subagent bridge", async () => {
    chatState.activeSessionId = "sess-1"
    chatState.openSessionIds = ["sess-1"]
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    applySdkSubagentBridgeMock.mockClear()
    const event = {
      type: "system",
      subtype: "task_started",
      task_id: "T1",
      subagent_type: "researcher",
      description: "d",
      uuid: "u",
      session_id: "sdk",
    }
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event })
    })
    await flush()
    expect(applySdkSubagentBridgeMock).toHaveBeenCalledWith(event, "sess-1")
  })

  it("skips the bridge block (incl. its getSession read) for stream_event token deltas", async () => {
    chatState.activeSessionId = "sess-1"
    chatState.openSessionIds = ["sess-1"]
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    applySdkSubagentBridgeMock.mockClear()
    getSessionMock.mockClear()
    adapterMock.applySdkEvent.mockReturnValueOnce({
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "t" }] }],
      turnComplete: false,
    })
    await act(async () => {
      _messageCallback?.({
        type: "event",
        sessionId: "sess-1",
        event: {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "t" } },
        },
      })
    })
    await flush()
    // The per-token hot path must not pay a Dexie session read or feed the
    // (no-op for deltas) plan / subagent bridges.
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(applySdkSubagentBridgeMock).not.toHaveBeenCalled()
  })

  it("send() is blocked (no sidecar call) when the concurrency cap is reached", async () => {
    isAtCapacityMock.mockReturnValue(true)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("blocked")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(chatState.setSessionStatus).not.toHaveBeenCalledWith("sess-1", "streaming")
  })

  it("stop(sessionId) interrupts the given session, not just the focused one", async () => {
    chatState.activeSessionId = "sess-other"
    chatState.openSessionIds = ["sess-other", "sess-1"]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.stop("sess-1")
    })
    expect(interruptSessionMock).toHaveBeenCalledWith("sess-1")
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
  })

  it("send(sessionId) targets the given session's slice", async () => {
    chatState.activeSessionId = "sess-other"
    chatState.openSessionIds = ["sess-other", "sess-1"]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("to-bg", undefined, { sessionId: "sess-1" })
    })
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", expect.anything(), expect.anything())
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "streaming")
  })

  it("close() tears down the session's pane state in the store", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.close("sess-1")
    })
    expect(closeSessionIpcMock).toHaveBeenCalledWith("sess-1")
    expect(chatState.closeSession).toHaveBeenCalledWith("sess-1")
  })
})

describe("useClaudeChat — pre-turn editor flush", () => {
  it("flushes unsaved editor buffers before the turn reaches the sidecar", async () => {
    // The agent's file tools read the filesystem, so an editor buffer the user
    // edited but never saved is invisible to them: the turn would reason about
    // stale content and its write would clobber that work.
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })

    expect(flushProjectEditorEdits).toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled()
    expect(flushProjectEditorEdits.mock.invocationCallOrder[0]).toBeLessThan(
      sendPromptMock.mock.invocationCallOrder[0]
    )
  })

  it("stays quiet when everything flushed cleanly", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })

    expect(toastWarning).not.toHaveBeenCalled()
  })

  it("warns about files it could not flush but still runs the turn", async () => {
    // The turn may not touch those files at all, so blocking would be wrong —
    // but for them disk is not what the user is looking at, and that must be said.
    flushProjectEditorEdits.mockResolvedValue(["/repo/a.ts", "/repo/b.ts"])
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })

    expect(toastWarning).toHaveBeenCalledTimes(1)
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("does not flush for a send the guards reject", async () => {
    // Empty content never becomes a turn, so nothing should be saved for it.
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("   ")
    })

    expect(flushProjectEditorEdits).not.toHaveBeenCalled()
  })
})
