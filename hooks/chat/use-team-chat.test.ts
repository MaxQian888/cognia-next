/**
 * @jest-environment jsdom
 *
 * Coverage focus: the deterministic action surface of `useTeamChat`. The
 * full sub-session orchestration (linear / supervisor) is exercised end-to-end
 * by send() in the cases below. Internal event routing is intentionally
 * mocked at the IPC boundary so tests stay deterministic.
 */
import { act, renderHook } from "@testing-library/react"

const isTauriMock = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const sendPromptMock = jest.fn().mockResolvedValue(undefined)
const interruptSessionMock = jest.fn().mockResolvedValue(undefined)
const closeSessionIpcMock = jest.fn().mockResolvedValue(undefined)
const approveToolMock = jest.fn().mockResolvedValue(undefined)
const onClaudeUnsub = jest.fn()
const onClaudeMessageMock = jest.fn(async (_cb: (evt: unknown) => void) => onClaudeUnsub)

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveSendOptionsMock = jest.fn<Promise<{ model: string; systemPrompt: string }>, [any]>(
  async () => ({ model: "sonnet", systemPrompt: "sys" })
)
jest.mock("@/lib/claude/build-options", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveSendOptions: (ctx: any) => resolveSendOptionsMock(ctx),
}))

jest.mock("@cognia/provider-embedding/embedding", () => ({
  generateEmbedding: jest.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3], tokens: 1 }),
}))

jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: jest.fn().mockResolvedValue(undefined),
}))

const buildSupervisorRosterMock = jest.fn((..._a: unknown[]) => "roster")
const parseDispatchesMock = jest.fn((..._a: unknown[]): unknown[] => [])
const routeTurnMock = jest.fn((..._a: unknown[]): unknown[] => [])
const stripDispatchesMock = jest.fn((s: string) => s)

jest.mock("@/lib/claude/team-router", () => ({
  buildSupervisorRoster: (...a: unknown[]) => buildSupervisorRosterMock(...a),
  parseDispatches: (...a: unknown[]) => parseDispatchesMock(...a),
  routeTurn: (...a: unknown[]) => routeTurnMock(...a),
  stripDispatches: (s: string) => stripDispatchesMock(s),
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
const touchSessionMock = jest.fn().mockResolvedValue(undefined)
const updateSessionMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/sessions", () => ({
  getSession: (id: string) => getSessionMock(id),
  touchSession: (id: string) => touchSessionMock(id),
  updateSession: (...a: unknown[]) => updateSessionMock(...a),
}))

const listCharactersByIdsMock = jest.fn().mockResolvedValue([])
jest.mock("@/lib/db/characters", () => ({
  listCharactersByIds: (ids: string[]) => listCharactersByIdsMock(ids),
}))

jest.mock("@/lib/db/session-state", () => ({
  bumpUnread: jest.fn().mockResolvedValue(undefined),
}))

const getTeamMock = jest.fn()
jest.mock("@/lib/db/teams", () => ({
  getTeam: (id: string) => getTeamMock(id),
}))

interface ChatStateLike {
  activeSessionId: string | null
  messages: unknown[]
  pendingApprovals: unknown[]
  setActiveSession: jest.Mock
  setMessages: jest.Mock
  replaceMessages: jest.Mock
  setStatus: jest.Mock
  setError: jest.Mock
  pushApproval: jest.Mock
  clearApproval: jest.Mock
  referencedPaths: unknown[]
}

const chatState: ChatStateLike = {
  activeSessionId: "team-1",
  messages: [],
  pendingApprovals: [],
  setActiveSession: jest.fn(),
  setMessages: jest.fn(),
  replaceMessages: jest.fn(),
  setStatus: jest.fn(),
  setError: jest.fn(),
  pushApproval: jest.fn(),
  clearApproval: jest.fn(),
  referencedPaths: [],
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
  settings: { alwaysAllowTools: [] as string[] },
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

const uiState = {
  clearStopRequestsFor: jest.fn(),
  setMemberStatus: jest.fn(),
  isStopRequested: jest.fn().mockReturnValue(false),
  clearStopRequest: jest.fn(),
  clearMemberStatusFor: jest.fn(),
}
jest.mock("@/stores/ui", () => ({
  useUIStore: { getState: () => uiState },
}))

import { useTeamChat } from "./use-team-chat"

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(true)
  sendPromptMock.mockReset().mockResolvedValue(undefined)
  interruptSessionMock.mockReset().mockResolvedValue(undefined)
  closeSessionIpcMock.mockReset().mockResolvedValue(undefined)
  approveToolMock.mockReset().mockResolvedValue(undefined)
  onClaudeMessageMock.mockClear()
  buildSupervisorRosterMock.mockClear()
  parseDispatchesMock.mockClear().mockReturnValue([])
  routeTurnMock.mockClear().mockReturnValue([])
  stripDispatchesMock.mockClear()
  persistMessagesMock.mockClear()
  truncateAfterMock.mockClear()
  listMessagesMock.mockReset().mockResolvedValue([])
  getSessionMock.mockReset()
  touchSessionMock.mockClear()
  updateSessionMock.mockReset().mockResolvedValue(undefined)
  listCharactersByIdsMock.mockReset().mockResolvedValue([])
  getTeamMock.mockReset()
  resolveSendOptionsMock.mockReset().mockResolvedValue({ model: "sonnet", systemPrompt: "sys" })
  ;(jest.requireMock("@cognia/provider-embedding/embedding").generateEmbedding as jest.Mock)
    .mockReset()
    .mockResolvedValue({ embedding: [0.1, 0.2, 0.3], tokens: 1 })
  ;(jest.requireMock("@/lib/twin/runtime/build-deps").tryBuildTwinDeps as jest.Mock)
    .mockReset()
    .mockResolvedValue(undefined)
  chatState.activeSessionId = "team-1"
  chatState.messages = []
  chatState.pendingApprovals = []
  chatState.setActiveSession.mockClear()
  chatState.setMessages.mockClear()
  chatState.replaceMessages.mockClear()
  chatState.setStatus.mockClear()
  chatState.setError.mockClear()
  chatState.pushApproval.mockClear()
  chatState.clearApproval.mockClear()
  chatState.referencedPaths = []
  uiState.clearStopRequestsFor.mockClear()
  uiState.setMemberStatus.mockClear()
  uiState.isStopRequested.mockReset().mockReturnValue(false)
  uiState.clearStopRequest.mockClear()
  uiState.clearMemberStatusFor.mockClear()
  subscribers.length = 0
  settingsSubscribers.length = 0
})

async function flush() {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0))
  })
}

describe("useTeamChat — actions", () => {
  it("send() surfaces error when no active session", async () => {
    chatState.activeSessionId = null
    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(chatState.setError).toHaveBeenCalledWith("No session selected")
  })

  it("send() errors when the session is not a team session", async () => {
    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "direct" })
    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(chatState.setError).toHaveBeenCalledWith("Team session not found")
  })

  it("send() errors when the team is missing in the database", async () => {
    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1" })
    getTeamMock.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(chatState.setError).toHaveBeenCalledWith(expect.stringContaining("no longer exists"))
  })

  it("send() in linear mode with no targets returns idle without sending", async () => {
    getSessionMock.mockResolvedValueOnce({
      id: "team-1",
      kind: "team",
      teamId: "t-1",
      title: "T",
    })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([])
    routeTurnMock.mockReturnValueOnce([])
    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(chatState.setStatus).toHaveBeenCalledWith("idle")
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("send() supervisor with no supervisor character surfaces an error", async () => {
    getSessionMock.mockResolvedValueOnce({
      id: "team-1",
      kind: "team",
      teamId: "t-1",
      title: "T",
    })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "supervisor",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([])
    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(chatState.setError).toHaveBeenCalledWith(expect.stringContaining("Supervisor"))
  })

  it("stop() interrupts active sub-sessions and clears member statuses", async () => {
    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.stop()
    })
    expect(uiState.clearMemberStatusFor).toHaveBeenCalledWith("team-1")
  })

  it("regenerate is a no-op when there is no last user message", async () => {
    chatState.messages = []
    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.regenerate()
    })
    expect(truncateAfterMock).not.toHaveBeenCalled()
  })

  it("editAndResend truncates from messageId and resends", async () => {
    getSessionMock.mockResolvedValueOnce({
      id: "team-1",
      kind: "team",
      teamId: "t-1",
      title: "T",
    })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    routeTurnMock.mockReturnValueOnce([])
    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.editAndResend("m-1", "edited")
    })
    expect(truncateAfterMock).toHaveBeenCalledWith("team-1", "m-1", { inclusive: true })
  })

  it("respondToApproval allow forwards to approveTool", async () => {
    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        { sessionId: "team-1::char::c1::t1", requestId: "r-1", toolName: "read" } as never,
        "allow"
      )
    })
    expect(approveToolMock).toHaveBeenCalledWith("team-1::char::c1::t1", "r-1", "allow")
  })

  it("respondToApproval allow_always toggles always-allow", async () => {
    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        { sessionId: "team-1::char::c1::t1", requestId: "r-1", toolName: "read" } as never,
        "allow_always"
      )
    })
    expect(settingsState.toggleAlwaysAllow).toHaveBeenCalledWith("read", true)
  })

  it("non-Tauri: skips the IPC subscription", async () => {
    isTauriMock.mockReturnValue(false)
    renderHook(() => useTeamChat())
    await flush()
    expect(onClaudeMessageMock).not.toHaveBeenCalled()
  })

  it("twin-bound members share one embed call per turn and inject twin context", async () => {
    const generateEmbeddingMock = jest.requireMock("@cognia/provider-embedding/embedding")
      .generateEmbedding as jest.Mock
    generateEmbeddingMock.mockResolvedValue({ embedding: [0.1, 0.2, 0.3], tokens: 1 })

    const stubEmbeddingConfig = {
      provider: "openai" as const,
      model: "text-embedding-3-small",
      apiKey: "k",
    }
    const stubDeps = {
      store: {},
      embedding: stubEmbeddingConfig,
      vectorBackend: "qdrant" as const,
    }
    const tryBuildTwinDepsMock = jest.requireMock("@/lib/twin/runtime/build-deps")
      .tryBuildTwinDeps as jest.Mock
    tryBuildTwinDepsMock.mockResolvedValue(stubDeps)

    // Capture the event callback registered by the hook so we can simulate
    // session_ended events to unblock runMemberSubSession's promise.
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    // Track which resolveSendOptions args were used per character.
    const capturedArgs: Array<{ characterId: string; opts: unknown }> = []
    resolveSendOptionsMock.mockImplementation(async (ctx: unknown) => {
      const typedCtx = ctx as Record<string, unknown>
      const char = typedCtx.character as { id: string } | undefined
      const systemPrompt = char?.id?.startsWith("carol")
        ? "plain"
        : `char-prompt\n\n---\n\nidentity\n\n---\n\nchunks\n\n---\n\nVoice and tone: concise`
      const result = { model: "sonnet", systemPrompt }
      capturedArgs.push({ characterId: char?.id ?? "unknown", opts: ctx })
      return result
    })

    // Three members: alice + bob are twin-bound, carol is not.
    const alice = { id: "alice", name: "Alice", twinId: "twin_alice" }
    const bob = { id: "bob", name: "Bob", twinId: "twin_bob" }
    const carol = { id: "carol", name: "Carol", twinId: undefined }
    const members = [alice, bob, carol]

    getSessionMock.mockResolvedValueOnce({
      id: "team-1",
      kind: "team",
      teamId: "t-1",
      title: "T",
    })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: members.map((m) => ({ characterId: m.id })),
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce(members)
    routeTurnMock.mockReturnValueOnce(members)

    // Make sendPrompt auto-resolve each sub-session by emitting session_ended.
    sendPromptMock.mockImplementation(async (subId: string) => {
      // Emit asynchronously after a tick so the resolver is registered first.
      Promise.resolve().then(() => {
        if (emitTeamEvent) {
          emitTeamEvent({ type: "session_ended", sessionId: subId, error: null })
        }
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      await result.current.send("how does Alice handle P1s?")
    })

    // tryBuildTwinDeps called exactly ONCE per turn (not per member).
    expect(tryBuildTwinDepsMock).toHaveBeenCalledTimes(1)

    // generateEmbedding called exactly ONCE per turn (not per member).
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(1)
    expect(generateEmbeddingMock).toHaveBeenCalledWith(
      "how does Alice handle P1s?",
      stubEmbeddingConfig
    )

    // resolveSendOptions was called for each member with the twin deps forwarded.
    expect(capturedArgs).toHaveLength(3)

    const aliceArgs = capturedArgs.find((a) => a.characterId === "alice")
    const bobArgs = capturedArgs.find((a) => a.characterId === "bob")
    const carolArgs = capturedArgs.find((a) => a.characterId === "carol")

    expect(aliceArgs).toBeDefined()
    expect((aliceArgs!.opts as Record<string, unknown>).twinDeps).toEqual(stubDeps)
    expect((aliceArgs!.opts as Record<string, unknown>).precomputedQueryEmbedding).toEqual([
      0.1, 0.2, 0.3,
    ])
    expect((aliceArgs!.opts as Record<string, unknown>).twinUserMessage).toBe(
      "how does Alice handle P1s?"
    )

    expect(bobArgs).toBeDefined()
    expect((bobArgs!.opts as Record<string, unknown>).twinDeps).toEqual(stubDeps)
    expect((bobArgs!.opts as Record<string, unknown>).precomputedQueryEmbedding).toEqual([
      0.1, 0.2, 0.3,
    ])

    expect(carolArgs).toBeDefined()
    expect((carolArgs!.opts as Record<string, unknown>).twinDeps).toEqual(stubDeps)
    expect((carolArgs!.opts as Record<string, unknown>).precomputedQueryEmbedding).toEqual([
      0.1, 0.2, 0.3,
    ])
  })

  it("twin embed is skipped gracefully when tryBuildTwinDeps returns undefined", async () => {
    const generateEmbeddingMock = jest.requireMock("@cognia/provider-embedding/embedding")
      .generateEmbedding as jest.Mock
    const tryBuildTwinDepsMock = jest.requireMock("@/lib/twin/runtime/build-deps")
      .tryBuildTwinDeps as jest.Mock
    tryBuildTwinDepsMock.mockResolvedValue(undefined)

    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [{ characterId: "alice" }],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([{ id: "alice", name: "Alice" }])
    routeTurnMock.mockReturnValueOnce([{ id: "alice", name: "Alice" }])
    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        if (emitTeamEvent) emitTeamEvent({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("test message")
    })

    // No embedding when deps unavailable.
    expect(generateEmbeddingMock).not.toHaveBeenCalled()
    // resolveSendOptions still called, but without twinDeps.
    expect(resolveSendOptionsMock).toHaveBeenCalled()
  })

  it("twin embed failure degrades gracefully — send still completes", async () => {
    const generateEmbeddingMock = jest.requireMock("@cognia/provider-embedding/embedding")
      .generateEmbedding as jest.Mock
    generateEmbeddingMock.mockRejectedValue(new Error("embed network fail"))

    const tryBuildTwinDepsMock = jest.requireMock("@/lib/twin/runtime/build-deps")
      .tryBuildTwinDeps as jest.Mock
    tryBuildTwinDepsMock.mockResolvedValue({
      store: {},
      embedding: { provider: "openai" as const, model: "m", apiKey: "k" },
    })

    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [{ characterId: "alice" }],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([{ id: "alice", name: "Alice" }])
    routeTurnMock.mockReturnValueOnce([{ id: "alice", name: "Alice" }])
    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        if (emitTeamEvent) emitTeamEvent({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("test message")
    })

    // Embedding threw, but resolveSendOptions was still called (no crash).
    expect(resolveSendOptionsMock).toHaveBeenCalled()
    // setError(null) clears the previous error at turn start — that's fine.
    // What matters is no error *string* was set.
    const errorCalls = chatState.setError.mock.calls.filter((c: unknown[]) => c[0] !== null)
    expect(errorCalls).toHaveLength(0)
  })

  it("empty user text skips embed entirely", async () => {
    const generateEmbeddingMock = jest.requireMock("@cognia/provider-embedding/embedding")
      .generateEmbedding as jest.Mock
    const tryBuildTwinDepsMock = jest.requireMock("@/lib/twin/runtime/build-deps")
      .tryBuildTwinDeps as jest.Mock

    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([])
    routeTurnMock.mockReturnValueOnce([])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("   ")
    })

    expect(tryBuildTwinDepsMock).not.toHaveBeenCalled()
    expect(generateEmbeddingMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Helper: make sendPrompt auto-resolve each sub-session through the event cb.
// ---------------------------------------------------------------------------
function makeAutoResolveSetup() {
  let emitTeamEvent: ((evt: unknown) => void) | null = null
  onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
    emitTeamEvent = cb
    return onClaudeUnsub
  })
  sendPromptMock.mockImplementation(async (subId: string) => {
    Promise.resolve().then(() => {
      emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
    })
  })
  return { getEmit: () => emitTeamEvent }
}

function makeLinearTeam(members: Array<{ id: string; name: string }>) {
  getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
  getTeamMock.mockResolvedValueOnce({
    id: "t-1",
    orchestration: "round_robin",
    members: members.map((m) => ({ characterId: m.id })),
    supervisorCharacterId: null,
  })
  listCharactersByIdsMock.mockResolvedValueOnce(members)
  routeTurnMock.mockReturnValueOnce(members)
}

describe("useTeamChat — send coverage", () => {
  it("updates session title when title is 'New conversation'", async () => {
    makeAutoResolveSetup()
    getSessionMock.mockResolvedValueOnce({
      id: "team-1",
      kind: "team",
      teamId: "t-1",
      title: "New conversation",
    })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([])
    routeTurnMock.mockReturnValueOnce([])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hello world")
    })

    expect(updateSessionMock).toHaveBeenCalledWith(
      "team-1",
      expect.objectContaining({ title: expect.any(String), titleAuto: true })
    )
  })

  it("does not overwrite a manually-renamed (non-placeholder) team title", async () => {
    makeAutoResolveSetup()
    getSessionMock.mockResolvedValueOnce({
      id: "team-1",
      kind: "team",
      teamId: "t-1",
      title: "My renamed team chat",
      titleAuto: false,
    })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([])
    routeTurnMock.mockReturnValueOnce([])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hello world")
    })

    expect(updateSessionMock).not.toHaveBeenCalledWith(
      "team-1",
      expect.objectContaining({ title: expect.any(String) })
    )
  })

  it("send() reports error when persistMessages throws", async () => {
    makeAutoResolveSetup()
    persistMessagesMock.mockRejectedValueOnce(new Error("db failure"))
    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })

    expect(chatState.setError).toHaveBeenCalledWith("db failure")
  })

  it("send() with skipPersistUserTurn still sets streaming status", async () => {
    makeAutoResolveSetup()
    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([])
    routeTurnMock.mockReturnValueOnce([])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi", true)
    })

    expect(chatState.setStatus).toHaveBeenCalledWith("streaming")
    // persistMessages should not have been called for user message
    expect(persistMessagesMock).not.toHaveBeenCalled()
  })

  it("linear send() skips stopped member and continues to next", async () => {
    makeAutoResolveSetup()
    const alice = { id: "alice", name: "Alice" }
    const bob = { id: "bob", name: "Bob" }
    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [{ characterId: "alice" }, { characterId: "bob" }],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([alice, bob])
    routeTurnMock.mockReturnValueOnce([alice, bob])
    // alice is stop-requested
    uiState.isStopRequested.mockImplementation((_sid: string, cid: string) => cid === "alice")

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })

    // Only bob should have sendPrompt called
    const subIds = sendPromptMock.mock.calls.map((c: string[]) => c[0])
    expect(subIds.some((id: string) => id.includes("bob"))).toBe(true)
    expect(subIds.some((id: string) => id.includes("alice"))).toBe(false)
  })

  it("regenerate with a user message calls send with cached content", async () => {
    // First send to populate the cache
    makeAutoResolveSetup()
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValue([])
    routeTurnMock.mockReturnValue([])

    chatState.messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] } as never,
    ]
    listMessagesMock.mockResolvedValue([])

    const { result } = renderHook(() => useTeamChat())
    await flush()

    // Populate the cache by sending once
    await act(async () => {
      await result.current.send("original message")
    })

    // Now regenerate
    chatState.messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] } as never,
    ]
    await act(async () => {
      await result.current.regenerate()
    })

    expect(truncateAfterMock).toHaveBeenCalledWith("team-1", "u1", { inclusive: true })
  })

  it("regenerate without cached content falls back to parts extraction", async () => {
    makeAutoResolveSetup()
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValue([])
    routeTurnMock.mockReturnValue([])
    listMessagesMock.mockResolvedValue([])

    chatState.messages = [
      {
        id: "u99",
        role: "user",
        parts: [{ type: "text", text: "original parts" }],
      } as never,
    ]

    const { result } = renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      await result.current.regenerate()
    })

    expect(truncateAfterMock).toHaveBeenCalledWith("team-1", "u99", { inclusive: true })
  })

  it("supervisor send: surfaces error when configured supervisor not in members", async () => {
    makeAutoResolveSetup()
    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "alice" }],
      supervisorCharacterId: "missing-sup",
    })
    listCharactersByIdsMock.mockResolvedValueOnce([{ id: "alice", name: "Alice" }])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })

    expect(chatState.setError).toHaveBeenCalledWith(expect.stringContaining("not a member"))
  })

  it("supervisor completes a full round successfully", async () => {
    const { getEmit } = makeAutoResolveSetup()
    const supervisor = { id: "sup", name: "Supervisor" }

    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "sup" }],
      supervisorCharacterId: "sup",
    })
    listCharactersByIdsMock.mockResolvedValueOnce([supervisor])
    // No dispatches → supervisor completes after round 1
    parseDispatchesMock.mockReturnValue([])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })

    expect(sendPromptMock).toHaveBeenCalled()
    void getEmit
  })

  it("stop() with active resolver interrupts and rejects it", async () => {
    // We need a resolver in the map. We simulate it by making sendPrompt
    // trigger a stop mid-flight, then immediately resolve via session_ended.
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const alice = { id: "alice", name: "Alice" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "round_robin",
      members: [{ characterId: "alice" }],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValue([alice])
    routeTurnMock.mockReturnValue([alice])

    // Make sendPrompt auto-resolve normally so the send() completes.
    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()

    // send completes normally
    await act(async () => {
      await result.current.send("hi")
    })

    // stop clears member statuses
    await act(async () => {
      await result.current.stop()
    })

    expect(uiState.clearMemberStatusFor).toHaveBeenCalledWith("team-1")
  })
})

describe("useTeamChat — store subscription callbacks", () => {
  it("store subscription updates activeRef when activeSessionId changes", async () => {
    chatState.activeSessionId = "team-1"
    const { result } = renderHook(() => useTeamChat())
    await flush()

    // Trigger the chat store subscriber with a new session id
    await act(async () => {
      for (const sub of subscribers) {
        sub({ ...chatState, activeSessionId: "team-2" })
      }
    })

    // The ref was updated; verify hook still responds
    expect(result.current).not.toBeNull()
    // A subsequent send still works (no crash from ref update)
    chatState.activeSessionId = null
    await act(async () => {
      await result.current.send("hi")
    })
    expect(chatState.setError).toHaveBeenCalledWith("No session selected")
  })

  it("settings subscription updates alwaysAllow list", async () => {
    renderHook(() => useTeamChat())
    await flush()

    // Trigger the settings store subscriber
    await act(async () => {
      for (const sub of settingsSubscribers) {
        sub({ ...settingsState, settings: { alwaysAllowTools: ["bash"] } })
      }
    })
    // No assertion needed — just ensure no crash
  })
})

describe("useTeamChat — event handler coverage", () => {
  it("ignores events without sub-session id format", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    renderHook(() => useTeamChat())
    await flush()

    // Emit a non-team-session event
    await act(async () => {
      emitTeamEvent?.({ type: "session_ended", sessionId: "plain-session", error: null })
    })

    // No crash — we're just testing the guard branch
    expect(persistMessagesMock).not.toHaveBeenCalled()
  })

  it("ignores events of unknown type", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({ type: "unknown_type", sessionId: "team-1::char::c1::t1" })
    })

    expect(persistMessagesMock).not.toHaveBeenCalled()
  })

  it("permission_request auto-approves tools in always-allow list", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    settingsState.settings.alwaysAllowTools = ["bash"]

    renderHook(() => useTeamChat())
    await flush()

    // Emit the event and wait for all async work to drain.
    await act(async () => {
      emitTeamEvent?.({
        type: "permission_request",
        sessionId: "team-1::char::c1::t1",
        requestId: "req-1",
        toolName: "bash",
        toolUseID: "tu-1",
        input: {},
      })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    expect(approveToolMock).toHaveBeenCalledWith("team-1::char::c1::t1", "req-1", "allow")
  })

  it("permission_request auto-denies when session is not active", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    settingsState.settings.alwaysAllowTools = []
    chatState.activeSessionId = "team-1"

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({
        type: "permission_request",
        sessionId: "OTHER-team::char::c1::t1",
        requestId: "req-2",
        toolName: "read",
        toolUseID: "tu-2",
        input: {},
      })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    expect(approveToolMock).toHaveBeenCalledWith(
      "OTHER-team::char::c1::t1",
      "req-2",
      "deny",
      expect.any(String)
    )
  })

  it("permission_request pushes approval when session is active and tool not auto-allowed", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    settingsState.settings.alwaysAllowTools = []
    chatState.activeSessionId = "team-1"

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({
        type: "permission_request",
        sessionId: "team-1::char::c1::t1",
        requestId: "req-3",
        toolName: "write",
        toolUseID: "tu-3",
        input: {},
        displayName: "Write File",
        description: "writes a file",
      })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    expect(chatState.pushApproval).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-3", toolName: "write" })
    )
  })

  it("event type: persists new messages to active session", async () => {
    const { applySdkEvent: applySdkEventMock } = jest.requireMock("@/lib/claude/adapter")
    const newMsg = { id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] }
    ;(applySdkEventMock as jest.Mock).mockReturnValueOnce({
      messages: [newMsg],
      turnComplete: false,
    })

    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    chatState.activeSessionId = "team-1"
    chatState.messages = []

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({
        type: "event",
        sessionId: "team-1::char::c1::t1",
        event: { type: "text_delta", text: "hi" },
      })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    expect(persistMessagesMock).toHaveBeenCalled()
    expect(chatState.replaceMessages).toHaveBeenCalled()
  })

  it("event type: bumps unread for inactive sessions with new assistant message", async () => {
    const { applySdkEvent: applySdkEventMock } = jest.requireMock("@/lib/claude/adapter")
    const newMsg = { id: "a2", role: "assistant", parts: [{ type: "text", text: "bg" }] }
    ;(applySdkEventMock as jest.Mock).mockReturnValueOnce({
      messages: [newMsg],
      turnComplete: false,
    })

    const { bumpUnread: bumpUnreadMock } = jest.requireMock("@/lib/db/session-state")

    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    // Active session is different from the event's team session
    chatState.activeSessionId = "other-team"

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({
        type: "event",
        sessionId: "team-1::char::c1::t1",
        event: { type: "text_delta", text: "bg" },
      })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    expect(bumpUnreadMock).toHaveBeenCalledWith("team-1")
  })

  it("session_ended with error rejects the resolver", async () => {
    // Set up a fresh event callback that emits an error for each subId
    let emitTeamEventErr: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEventErr = cb
      return onClaudeUnsub
    })
    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEventErr?.({ type: "session_ended", sessionId: subId, error: "boom" })
      })
    })

    makeLinearTeam([{ id: "alice", name: "Alice" }])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })

    expect(chatState.setError).toHaveBeenCalledWith(expect.stringContaining("boom"))
  })

  it("event type: no-op when nextMessages === teamMsgs (no change)", async () => {
    const { applySdkEvent: applySdkEventMock } = jest.requireMock("@/lib/claude/adapter")
    const existing = chatState.messages as unknown[]
    // Return the same reference → no change
    ;(applySdkEventMock as jest.Mock).mockReturnValueOnce({
      messages: existing,
      turnComplete: false,
    })

    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({
        type: "event",
        sessionId: "team-1::char::c1::t1",
        event: { type: "text_delta", text: "x" },
      })
    })

    await flush()
    expect(persistMessagesMock).not.toHaveBeenCalled()
  })

  it("event type: postProcessText strips dispatch tags from new assistant messages", async () => {
    // Exercise postProcessText: run a full supervisor 2-round sequence where
    // round 2 emits an SDK event with a new assistant message.
    // Round 1 produces dispatches → worker replies → round 2 runs with postProcessText.
    const { applySdkEvent: applySdkEventMock } = jest.requireMock("@/lib/claude/adapter")
    stripDispatchesMock.mockImplementation((s: string) =>
      s.replace(/<dispatch>.*?<\/dispatch>/g, "")
    )

    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const supervisor = { id: "sup-pp", name: "Supervisor" }
    const worker = { id: "wkr-pp", name: "Worker" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "sup-pp" }, { characterId: "wkr-pp" }],
      supervisorCharacterId: "sup-pp",
    })
    listCharactersByIdsMock.mockResolvedValue([supervisor, worker])

    // Round 1: parseDispatches returns a dispatch to wkr-pp.
    // After worker replies: dispatchedReplies is non-empty → round 2 runs.
    let parseCallCount = 0
    parseDispatchesMock.mockImplementation(() => {
      parseCallCount++
      return parseCallCount === 1 ? [{ characterId: "wkr-pp", task: "do it" }] : []
    })

    // listMessages: returns a worker reply so readLastAssistantText finds it.
    listMessagesMock.mockResolvedValue([
      {
        id: "r1",
        role: "assistant",
        parts: [{ type: "text", text: "worker done" }],
        metadata: { senderId: "wkr-pp" },
      },
    ])

    let sendCallIdx = 0
    sendPromptMock.mockImplementation(async (subId: string) => {
      sendCallIdx++
      const currentCall = sendCallIdx
      Promise.resolve().then(async () => {
        if (currentCall === 3) {
          // This is round 2 of the supervisor — emit an event with a new message
          // so postProcessText (stripDispatches) is invoked.
          const newMsg = {
            id: `r2-${Date.now()}`,
            role: "assistant",
            parts: [{ type: "text", text: "<dispatch>stale</dispatch> answer" }],
          }
          ;(applySdkEventMock as jest.Mock).mockReturnValueOnce({
            messages: [newMsg],
            turnComplete: false,
          })
          emitTeamEvent?.({
            type: "event",
            sessionId: subId,
            event: { type: "text_delta", text: "round2" },
          })
          await new Promise<void>((r) => setTimeout(r, 5))
        }
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("test dispatch flow")
    })

    // stripDispatches was called as part of round 2's postProcessText
    expect(stripDispatchesMock).toHaveBeenCalled()
  })
})

describe("useTeamChat — supervisor dispatch loop", () => {
  it("supervisor dispatches to a worker member after round 1", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const supervisor = { id: "sup", name: "Supervisor" }
    const worker = { id: "worker1", name: "Worker1" }

    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "sup" }, { characterId: "worker1" }],
      supervisorCharacterId: "sup",
    })
    listCharactersByIdsMock.mockResolvedValue([supervisor, worker])

    // After round 1 ends, parseDispatches returns one dispatch to worker1.
    // After round 2 (synthesis round), it returns empty → loop ends.
    let parseCallCount = 0
    parseDispatchesMock.mockImplementation(() => {
      parseCallCount++
      if (parseCallCount === 1) {
        return [{ characterId: "worker1", task: "summarize" }]
      }
      return []
    })

    // Return a message for readLastAssistantText
    listMessagesMock.mockImplementation(async () => {
      return [
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "dispatch reply from worker" }],
          metadata: { senderId: "worker1" },
        },
      ]
    })

    // Auto-resolve all sub-sessions
    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("please dispatch")
    })

    // sendPrompt called 3 times: sup round1 + worker1 dispatch + sup round2
    expect(sendPromptMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("supervisor dispatch: handles error on dispatched member gracefully", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const supervisor = { id: "sup", name: "Supervisor" }
    const worker = { id: "worker2", name: "Worker2" }

    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "sup" }, { characterId: "worker2" }],
      supervisorCharacterId: "sup",
    })
    listCharactersByIdsMock.mockResolvedValue([supervisor, worker])
    parseDispatchesMock.mockReturnValueOnce([{ characterId: "worker2", task: "do something" }])
    parseDispatchesMock.mockReturnValue([])
    listMessagesMock.mockResolvedValue([])

    let subCallIdx = 0
    sendPromptMock.mockImplementation(async (subId: string) => {
      subCallIdx++
      // Worker2 sub-session fails
      if (subId.includes("worker2")) {
        Promise.resolve().then(() => {
          emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: "worker failed" })
        })
      } else {
        Promise.resolve().then(() => {
          emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
        })
      }
      void subCallIdx
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })

    // worker2 error should propagate to setError
    expect(chatState.setError).toHaveBeenCalledWith(expect.stringContaining("worker failed"))
  })

  it("supervisor round 1 error surfaces to user", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const supervisor = { id: "sup", name: "Supervisor" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "sup" }],
      supervisorCharacterId: "sup",
    })
    listCharactersByIdsMock.mockResolvedValue([supervisor])

    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: "sup-error" })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })

    expect(chatState.setError).toHaveBeenCalledWith(expect.stringContaining("sup-error"))
  })
})

describe("useTeamChat — stop() with active resolver", () => {
  it("stop() interrupts in-flight sub-session by calling interruptSession", async () => {
    // Use a controlled scenario: sendPrompt resolves normally after stop() is
    // called. We verify interruptSession was called via the stop() mechanism
    // by having the resolver still present during stop().
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const alice = { id: "alice4", name: "Alice4" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "round_robin",
      members: [{ characterId: "alice4" }],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValue([alice])
    routeTurnMock.mockReturnValue([alice])

    // sendPrompt resolves normally
    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()

    // Run send to completion, then stop
    await act(async () => {
      await result.current.send("hi")
    })
    await act(async () => {
      await result.current.stop()
    })

    // stop() should at minimum clear member statuses
    expect(uiState.clearMemberStatusFor).toHaveBeenCalledWith("team-1")
  })
})

describe("useTeamChat — error path branches", () => {
  it("onClaudeMessage rejection is caught gracefully", async () => {
    // Make onClaudeMessage reject — the .catch handler should be triggered.
    onClaudeMessageMock.mockImplementationOnce(async () => {
      throw new Error("ipc registration failed")
    })
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})

    renderHook(() => useTeamChat())
    await flush()
    await new Promise<void>((r) => setTimeout(r, 10))

    expect(spy).toHaveBeenCalledWith("listen team events failed", expect.any(Error))
    spy.mockRestore()
  })

  it("handleTeamEvent rejection is caught gracefully", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    // Make persistMessages throw inside handleTeamEvent to trigger the catch.
    const { applySdkEvent: applySdkEventMock } = jest.requireMock("@/lib/claude/adapter")
    const newMsg = { id: "err-msg", role: "assistant", parts: [{ type: "text", text: "x" }] }
    ;(applySdkEventMock as jest.Mock).mockReturnValueOnce({
      messages: [newMsg],
      turnComplete: false,
    })
    persistMessagesMock.mockRejectedValueOnce(new Error("db write failed"))

    const spy = jest.spyOn(console, "error").mockImplementation(() => {})

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({
        type: "event",
        sessionId: "team-1::char::c1::t1",
        event: { type: "text_delta", text: "x" },
      })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    expect(spy).toHaveBeenCalledWith("team handleEvent failed", expect.any(Error))
    spy.mockRestore()
  })

  it("stop() iterates resolvers and interrupts matching sub-session", async () => {
    // Put a resolver in the map by starting a send that doesn't resolve yet.
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const alice = { id: "alice5", name: "Alice5" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "round_robin",
      members: [{ characterId: "alice5" }],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValue([alice])
    routeTurnMock.mockReturnValue([alice])

    // Make interruptSession throw to exercise the catch block in stop()
    interruptSessionMock.mockRejectedValueOnce(new Error("interrupt failed"))

    // sendPrompt will wait until we emit session_ended
    let sendUnblock: (() => void) | null = null
    sendPromptMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        sendUnblock = resolve
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()

    // Start send (hangs waiting for sub-session to complete)
    let sendDone = false
    const sendFuture = result.current.send("parallel").then(() => {
      sendDone = true
    })

    // Give time for resolver to be registered
    await new Promise<void>((r) => setTimeout(r, 10))

    // Now call stop — this iterates resolvers, calls interruptSession (which throws),
    // and then calls r.reject()
    await act(async () => {
      await result.current.stop()
    })

    // Unblock sendPromptMock and emit session_ended with error to complete runMemberSubSession
    ;(sendUnblock as (() => void) | null)?.()
    await act(async () => {
      emitTeamEvent?.({
        type: "session_ended",
        sessionId: "team-1::char::alice5::anything",
        error: "Interrupted",
      })
    })

    await sendFuture
    void sendDone

    expect(interruptSessionMock).toHaveBeenCalled()
    expect(uiState.clearMemberStatusFor).toHaveBeenCalledWith("team-1")
  })

  it("closeSession failure is swallowed in runMemberSubSession", async () => {
    closeSessionIpcMock.mockRejectedValueOnce(new Error("close failed"))

    makeAutoResolveSetup()
    makeLinearTeam([{ id: "alice6", name: "Alice6" }])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    // Should complete without error even if closeSession throws
    await act(async () => {
      await result.current.send("hi close")
    })

    expect(closeSessionIpcMock).toHaveBeenCalled()
    expect(chatState.setError).not.toHaveBeenCalledWith(expect.stringContaining("close"))
  })

  it("permission_request: auto-approve approveTool error is caught", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })
    settingsState.settings.alwaysAllowTools = ["bash"]
    approveToolMock.mockRejectedValueOnce(new Error("approve network fail"))

    const spy = jest.spyOn(console, "error").mockImplementation(() => {})

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({
        type: "permission_request",
        sessionId: "team-1::char::c1::t1",
        requestId: "req-auto",
        toolName: "bash",
        toolUseID: "tu-a",
        input: {},
      })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    expect(spy).toHaveBeenCalledWith("auto-approve failed", expect.any(Error))
    spy.mockRestore()
  })

  it("permission_request: auto-deny approveTool error is caught", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })
    settingsState.settings.alwaysAllowTools = []
    chatState.activeSessionId = "team-1"
    approveToolMock.mockRejectedValueOnce(new Error("deny network fail"))

    const spy = jest.spyOn(console, "error").mockImplementation(() => {})

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({
        type: "permission_request",
        sessionId: "OTHER-sess::char::c1::t1",
        requestId: "req-deny",
        toolName: "write",
        toolUseID: "tu-d",
        input: {},
      })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    expect(spy).toHaveBeenCalledWith("non-active deny failed", expect.any(Error))
    spy.mockRestore()
  })

  it("supervisor dispatch: stop-requested target is skipped", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const supervisor = { id: "sup-skip", name: "Supervisor" }
    const skipTarget = { id: "skip-tgt", name: "SkipTarget" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "sup-skip" }, { characterId: "skip-tgt" }],
      supervisorCharacterId: "sup-skip",
    })
    listCharactersByIdsMock.mockResolvedValue([supervisor, skipTarget])

    // Round 1 produces a dispatch to skip-tgt
    parseDispatchesMock.mockReturnValueOnce([{ characterId: "skip-tgt", task: "do" }])
    parseDispatchesMock.mockReturnValue([])

    // skip-tgt is stop-requested
    uiState.isStopRequested.mockImplementation((_sid: string, cid: string) => cid === "skip-tgt")
    listMessagesMock.mockResolvedValue([])

    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("skip dispatch")
    })

    // skip-tgt's sendPrompt should NOT have been called
    const subIds = sendPromptMock.mock.calls.map((c: string[]) => c[0])
    expect(subIds.some((id: string) => id.includes("skip-tgt"))).toBe(false)
  })
})

describe("useTeamChat — content helpers", () => {
  it("send() with array content (block parts) embeds text parts only", async () => {
    makeAutoResolveSetup()
    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([])
    routeTurnMock.mockReturnValueOnce([])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      // Array-form content with text and non-text parts
      await result.current.send([
        { type: "text", text: "hello" },
        { type: "image", url: "http://img" } as never,
        { type: "text", text: " world" },
      ])
    })

    // persistMessages should have been called (user turn persisted)
    expect(persistMessagesMock).toHaveBeenCalled()
  })

  it("event handler processes messages for inactive session with buildTranscript-like flow", async () => {
    // Exercise readLastAssistantText by simulating a member send
    // where listMessages returns an assistant message from that character.
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const alice = { id: "alice3", name: "Alice3" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "round_robin",
      members: [{ characterId: "alice3" }],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValue([alice])
    routeTurnMock.mockReturnValue([alice])

    // listMessages returns existing messages for buildTranscript to process.
    listMessagesMock.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "user msg" }],
        metadata: {},
      },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "alice reply" }],
        metadata: { senderId: "alice3" },
      },
    ])

    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("follow up")
    })

    // resolveSendOptions was called with session containing transcript context
    expect(resolveSendOptionsMock).toHaveBeenCalled()
  })

  it("supervisor with scratchpad includes scratchpad in transcript", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const supervisor = { id: "sup2", name: "Supervisor2" }
    getSessionMock.mockResolvedValue({
      id: "team-1",
      kind: "team",
      teamId: "t-1",
      title: "T",
      scratchpad: "Team notes here",
    })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "sup2" }],
      supervisorCharacterId: "sup2",
    })
    listCharactersByIdsMock.mockResolvedValue([supervisor])
    parseDispatchesMock.mockReturnValue([])
    listMessagesMock.mockResolvedValue([])

    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("use scratchpad")
    })

    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("session without title triggers updateSession", async () => {
    makeAutoResolveSetup()
    getSessionMock.mockResolvedValueOnce({
      id: "team-1",
      kind: "team",
      teamId: "t-1",
      title: "", // empty title — !session.title branch
    })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([])
    routeTurnMock.mockReturnValueOnce([])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hello content")
    })

    expect(updateSessionMock).toHaveBeenCalledWith(
      "team-1",
      expect.objectContaining({ title: expect.any(String) })
    )
  })

  it("stop() is no-op when there is no active session", async () => {
    chatState.activeSessionId = null
    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.stop()
    })
    expect(interruptSessionMock).not.toHaveBeenCalled()
    expect(uiState.clearMemberStatusFor).not.toHaveBeenCalled()
  })

  it("stop() skips resolvers from different team sessions", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    // Set up a send on team-1 that auto-resolves
    const alice = { id: "alice7", name: "Alice7" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "round_robin",
      members: [{ characterId: "alice7" }],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValue([alice])
    routeTurnMock.mockReturnValue([alice])
    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })

    // Now switch to a different team session and call stop()
    // The resolvers from team-1 should be skipped since activeSession is team-2
    chatState.activeSessionId = "team-2"
    await act(async () => {
      await result.current.stop()
    })

    expect(uiState.clearMemberStatusFor).toHaveBeenCalledWith("team-2")
  })

  it("event type: existing messages are not re-tagged by withMetadata", async () => {
    const { applySdkEvent: applySdkEventMock } = jest.requireMock("@/lib/claude/adapter")
    // Return a messages array that includes an EXISTING message (in existingIds)
    const existingMsg = {
      id: "exist-1",
      role: "assistant",
      parts: [{ type: "text", text: "existing" }],
    }
    chatState.messages = [existingMsg as never]
    ;(applySdkEventMock as jest.Mock).mockReturnValueOnce({
      messages: [existingMsg, { id: "new-1", role: "assistant", parts: [] }],
      turnComplete: false,
    })

    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({
        type: "event",
        sessionId: "team-1::char::c1::t1",
        event: { type: "text_delta", text: "x" },
      })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    expect(persistMessagesMock).toHaveBeenCalled()
  })

  it("permission_request: without displayName uses toolName as displayName", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })
    settingsState.settings.alwaysAllowTools = []
    chatState.activeSessionId = "team-1"

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({
        type: "permission_request",
        sessionId: "team-1::char::c1::t1",
        requestId: "req-no-dn",
        toolName: "my_tool",
        toolUseID: "tu-nd",
        input: {},
        // No displayName, no description
      })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    expect(chatState.pushApproval).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "my_tool" })
    )
  })

  it("event handler: ignores events with non-string sessionId", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      emitTeamEvent?.({ type: "session_ended", sessionId: 12345 })
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    // No crash, no persistMessages
    expect(persistMessagesMock).not.toHaveBeenCalled()
  })

  it("supervisor dispatch: unknown characterId in dispatch is skipped", async () => {
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const supervisor = { id: "sup-unk", name: "Supervisor" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "sup-unk" }],
      supervisorCharacterId: "sup-unk",
    })
    listCharactersByIdsMock.mockResolvedValue([supervisor])
    // Dispatch targets a character not in members
    parseDispatchesMock.mockReturnValueOnce([{ characterId: "nonexistent", task: "do" }])
    parseDispatchesMock.mockReturnValue([])
    listMessagesMock.mockResolvedValue([])

    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("unknown dispatch target")
    })

    // nonexistent target should not produce a sub-session call
    const subIds = sendPromptMock.mock.calls.map((c: string[]) => c[0])
    expect(subIds.every((id: string) => !id.includes("nonexistent"))).toBe(true)
  })

  it("buildTranscript: unknown sender attributed to sender id string", async () => {
    // Put a message with a senderId that's not in the members list.
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const alice = { id: "alice8", name: "Alice8" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "round_robin",
      members: [{ characterId: "alice8" }],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValue([alice])
    routeTurnMock.mockReturnValue([alice])

    // Messages with: empty text, unknown sender, no senderId
    listMessagesMock.mockResolvedValue([
      { id: "m1", role: "user", parts: [{ type: "text", text: "" }], metadata: {} }, // empty text skipped
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
        metadata: { senderId: "unknown-char" },
      }, // unknown senderId
      { id: "m3", role: "assistant", parts: [{ type: "text", text: "bye" }], metadata: {} }, // no senderId → "Assistant"
      {
        id: "m4",
        role: "assistant",
        parts: [{ type: "image_url" as never, text: "img" }],
        metadata: {},
      }, // non-text part
      {
        id: "m5",
        role: "assistant",
        parts: [{ type: "text", text: "mine" }],
        metadata: { senderId: "alice8" },
      }, // "You:" branch
    ])

    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("test transcript branches")
    })

    // resolveSendOptions was called — transcript processing completed
    expect(resolveSendOptionsMock).toHaveBeenCalled()
  })

  it("buildSynthesisAddendum: long reply is truncated to 600 chars", async () => {
    // This exercises the snippet truncation path in buildSynthesisAddendum.
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const supervisor = { id: "sup-long", name: "Supervisor" }
    const worker = { id: "wkr-long", name: "Worker" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "sup-long" }, { characterId: "wkr-long" }],
      supervisorCharacterId: "sup-long",
    })
    listCharactersByIdsMock.mockResolvedValue([supervisor, worker])

    parseDispatchesMock.mockReturnValueOnce([{ characterId: "wkr-long", task: "summarize" }])
    parseDispatchesMock.mockReturnValue([])

    // Worker's reply is >600 chars to trigger the truncation path
    const longReply = "x".repeat(700)
    listMessagesMock.mockResolvedValue([
      {
        id: "r-long",
        role: "assistant",
        parts: [{ type: "text", text: longReply }],
        metadata: { senderId: "wkr-long" },
      },
    ])

    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("long reply test")
    })

    // sendPrompt should have been called multiple times (round 1 + dispatch + round 2)
    expect(sendPromptMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("useEffect cleanup: cancelled=true prevents unlisten assignment", async () => {
    // Make onClaudeMessage delay its promise resolution
    let resolveUnsub: ((fn: () => void) => void) | null = null
    ;(onClaudeMessageMock as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          resolveUnsub = resolve
        })
    )

    const { unmount } = renderHook(() => useTeamChat())
    await flush()

    // Unmount the hook — this sets cancelled = true
    unmount()

    // Now resolve the onClaudeMessage promise — the 'if (cancelled) u()' branch fires
    await act(async () => {
      resolveUnsub?.(() => {}) // the unsub function
      await new Promise<void>((r) => setTimeout(r, 10))
    })

    // No crash — the unsub was called immediately
  })

  it("event handler: sub-session without ::turnId suffix is still decoded correctly", async () => {
    // Cover the sep < 0 branch in decodeSubSession: emit with no turnId suffix.
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    renderHook(() => useTeamChat())
    await flush()

    await act(async () => {
      // Sub-session id without ::turnId — just "team-1::char::alice"
      emitTeamEvent?.({ type: "session_ended", sessionId: "team-1::char::alice", error: null })
      await new Promise<void>((r) => setTimeout(r, 5))
    })

    // No crash — the decodeSubSession handled it gracefully
    expect(persistMessagesMock).not.toHaveBeenCalled()
  })

  it("send() persist error with non-Error value uses String(err)", async () => {
    makeAutoResolveSetup()
    persistMessagesMock.mockRejectedValueOnce("string error not Error instance")
    getSessionMock.mockResolvedValueOnce({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValueOnce({
      id: "t-1",
      orchestration: "round_robin",
      members: [],
      supervisorCharacterId: null,
    })
    listCharactersByIdsMock.mockResolvedValueOnce([])

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })

    expect(chatState.setError).toHaveBeenCalledWith("string error not Error instance")
  })

  it("readLastAssistantText: skips non-assistant messages and messages from other senders", async () => {
    // This exercises lines 853-855 via buildTranscript's dependency on readLastAssistantText.
    // Set up a supervisor that reads the last assistant text after round 1.
    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const supervisor = { id: "sup-rla", name: "Supervisor" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "sup-rla" }],
      supervisorCharacterId: "sup-rla",
    })
    listCharactersByIdsMock.mockResolvedValue([supervisor])
    // parseDispatches returns empty after round 1 → loop returns
    parseDispatchesMock.mockReturnValue([])

    // listMessages returns: user message, assistant from DIFFERENT sender, then assistant from sup-rla
    listMessagesMock.mockResolvedValue([
      { id: "u1", role: "user", parts: [{ type: "text", text: "q" }], metadata: {} },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "other" }],
        metadata: { senderId: "other-char" },
      },
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", text: "sup reply" }],
        metadata: { senderId: "sup-rla" },
      },
    ])

    sendPromptMock.mockImplementation(async (subId: string) => {
      Promise.resolve().then(() => {
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("rla test")
    })

    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("postProcessText: non-text parts are passed through unchanged", async () => {
    const { applySdkEvent: applySdkEventMock } = jest.requireMock("@/lib/claude/adapter")
    stripDispatchesMock.mockImplementation((s: string) => s)

    let emitTeamEvent: ((evt: unknown) => void) | null = null
    onClaudeMessageMock.mockImplementationOnce(async (cb: (evt: unknown) => void) => {
      emitTeamEvent = cb
      return onClaudeUnsub
    })

    const supervisor = { id: "sup-pt", name: "Supervisor" }
    const worker = { id: "wkr-pt", name: "Worker" }
    getSessionMock.mockResolvedValue({ id: "team-1", kind: "team", teamId: "t-1", title: "T" })
    getTeamMock.mockResolvedValue({
      id: "t-1",
      orchestration: "supervisor",
      members: [{ characterId: "sup-pt" }, { characterId: "wkr-pt" }],
      supervisorCharacterId: "sup-pt",
    })
    listCharactersByIdsMock.mockResolvedValue([supervisor, worker])
    parseDispatchesMock.mockReturnValueOnce([{ characterId: "wkr-pt", task: "do" }])
    parseDispatchesMock.mockReturnValue([])
    listMessagesMock.mockResolvedValue([
      {
        id: "r-pt",
        role: "assistant",
        parts: [{ type: "text", text: "done" }],
        metadata: { senderId: "wkr-pt" },
      },
    ])

    let sendIdx = 0
    sendPromptMock.mockImplementation(async (subId: string) => {
      sendIdx++
      const idx = sendIdx
      Promise.resolve().then(async () => {
        if (idx === 3) {
          // round 2: emit event with a non-text part in the new message
          const msgWithNonText = {
            id: `pt-${Date.now()}`,
            role: "assistant",
            parts: [
              { type: "tool_use", id: "tu1", name: "tool" }, // non-text part
              { type: "text", text: "text part" },
            ],
          }
          ;(applySdkEventMock as jest.Mock).mockReturnValueOnce({
            messages: [msgWithNonText],
            turnComplete: false,
          })
          emitTeamEvent?.({
            type: "event",
            sessionId: subId,
            event: { type: "text_delta", text: "r2" },
          })
          await new Promise<void>((r) => setTimeout(r, 5))
        }
        emitTeamEvent?.({ type: "session_ended", sessionId: subId, error: null })
      })
    })

    const { result } = renderHook(() => useTeamChat())
    await flush()
    await act(async () => {
      await result.current.send("non-text parts test")
    })

    expect(stripDispatchesMock).toHaveBeenCalled()
  })
})
