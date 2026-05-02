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

  it("regenerate uses the last user turn when present", async () => {
    chatState.messages = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.regenerate()
    })
    expect(truncateAfterMock).toHaveBeenCalledWith("sess-1", "u-1", { inclusive: true })
  })

  it("non-Tauri: skips the message subscription", async () => {
    isTauriMock.mockReturnValue(false)
    renderHook(() => useClaudeChat())
    await flush()
    expect(onClaudeMessageMock).not.toHaveBeenCalled()
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
      })
    )
  })
})
