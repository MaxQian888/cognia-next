/**
 * @jest-environment jsdom
 *
 * Coverage focus: the deterministic action surface of `useClaudeChat`.
 * The hook also wires a long-lived sidecar event handler through `onClaudeMessage`
 * — that handler is exercised indirectly via `send` / `respondToApproval`.
 */
import { act, renderHook } from "@testing-library/react"

const isTauriMock = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

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
jest.mock("@/lib/claude/adapter-hooks", () => ({
  dispatchUserPromptSubmit: (...a: unknown[]) => dispatchUserPromptSubmitMock(...(a as [])),
  dispatchChatError: (...a: unknown[]) => dispatchChatErrorMock(...(a as [])),
}))

interface ChatStateLike {
  activeSessionId: string | null
  messages: unknown[]
  pendingApprovals: unknown[]
  pendingCommandOverrides: unknown
  referencedPaths: unknown[]
  setActiveSession: jest.Mock
  setMessages: jest.Mock
  replaceMessages: jest.Mock
  setStatus: jest.Mock
  setError: jest.Mock
  pushApproval: jest.Mock
  clearApproval: jest.Mock
  setPendingCommandOverrides: jest.Mock
}

const chatState: ChatStateLike = {
  activeSessionId: "sess-1",
  messages: [],
  pendingApprovals: [],
  pendingCommandOverrides: null,
  referencedPaths: [],
  setActiveSession: jest.fn(),
  setMessages: jest.fn(),
  replaceMessages: jest.fn(),
  setStatus: jest.fn(),
  setError: jest.fn(),
  pushApproval: jest.fn(),
  clearApproval: jest.fn(),
  setPendingCommandOverrides: jest.fn(),
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
  chatState.setActiveSession.mockClear()
  chatState.setMessages.mockClear()
  chatState.replaceMessages.mockClear()
  chatState.setStatus.mockClear()
  chatState.setError.mockClear()
  chatState.pushApproval.mockClear()
  chatState.clearApproval.mockClear()
  chatState.setPendingCommandOverrides.mockClear()
  subscribers.length = 0
  settingsSubscribers.length = 0
  mockGetTwinRuntimeSettings.mockReset()
  mockCreateVectorStore.mockReset()
})

async function flush() {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0))
  })
}

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
  })

  it("send() updates the title for a new session", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("new prompt")
    })
    expect(updateSessionMock).toHaveBeenCalledWith(
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
