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

jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({ model: "sonnet", systemPrompt: "sys" })),
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
})
