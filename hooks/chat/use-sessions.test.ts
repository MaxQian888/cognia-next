/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const liveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(fn: () => Promise<T> | T): T | undefined => liveQueryMock(fn) as T | undefined,
}))

const listMessagesMock = jest.fn()
const persistMessagesMock = jest.fn()
jest.mock("@/lib/db/messages", () => ({
  listMessages: (id: string) => listMessagesMock(id),
  persistMessages: (id: string, msgs: unknown) => persistMessagesMock(id, msgs),
}))

const createSessionMock = jest.fn()
const deleteSessionMock = jest.fn()
const bulkDeleteSessionsMock = jest.fn()
const listSessionsMock = jest.fn()
const listAllSessionsMock = jest.fn()
const updateSessionMock = jest.fn()
const getSessionMock = jest.fn()
const archiveSessionMock = jest.fn()
const unarchiveSessionMock = jest.fn()
const bulkArchiveSessionsMock = jest.fn()
const bulkUnarchiveSessionsMock = jest.fn()
const bulkSetSessionsPinnedMock = jest.fn()
const assignSessionToFolderMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  createSession: (p: unknown) => createSessionMock(p),
  deleteSession: (id: string) => deleteSessionMock(id),
  bulkDeleteSessions: (ids: readonly string[]) => bulkDeleteSessionsMock(ids),
  listScopedSessions: (projectId?: string) => listSessionsMock(projectId),
  listSessions: () => listAllSessionsMock(),
  updateSession: (id: string, p: unknown) => updateSessionMock(id, p),
  getSession: (id: string) => getSessionMock(id),
  archiveSession: (id: string) => archiveSessionMock(id),
  unarchiveSession: (id: string) => unarchiveSessionMock(id),
  bulkArchiveSessions: (ids: readonly string[]) => bulkArchiveSessionsMock(ids),
  bulkUnarchiveSessions: (ids: readonly string[]) => bulkUnarchiveSessionsMock(ids),
  bulkSetSessionsPinned: (ids: readonly string[], pinned: boolean) =>
    bulkSetSessionsPinnedMock(ids, pinned),
  assignSessionToFolder: (sid: string, fid: string | null) => assignSessionToFolderMock(sid, fid),
}))

const listFoldersMock = jest.fn()
const createFolderDbMock = jest.fn()
const renameFolderDbMock = jest.fn()
const deleteFolderDbMock = jest.fn()
jest.mock("@/lib/db/session-folders", () => ({
  listFolders: (projectId?: string) => listFoldersMock(projectId),
  createFolder: (name: string) => createFolderDbMock(name),
  renameFolder: (id: string, name: string) => renameFolderDbMock(id, name),
  deleteFolder: (id: string) => deleteFolderDbMock(id),
}))

const resolveCharacterByIdMock = jest.fn()
jest.mock("@/lib/db/characters", () => ({
  resolveCharacterById: (id: string) => resolveCharacterByIdMock(id),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ connected: true }),
}))

const closeSessionIpcMock = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  closeSession: (id: string) => closeSessionIpcMock(id),
}))

const chatStoreState = {
  setActiveSession: jest.fn(),
  setMessages: jest.fn(),
  setMessagesLoadError: jest.fn(),
  hydrateSessionActiveBranches: jest.fn(),
  activeSessionId: null as string | null,
  messagesReloadNonce: 0,
}

jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(
    <T>(selector: (s: typeof chatStoreState) => T): T => selector(chatStoreState),
    {
      getState: () => chatStoreState,
    }
  ),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn().mockReturnValue(true),
}))
const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri

const isCapacitorMock = jest.fn().mockReturnValue(false)
jest.mock("@/lib/platform/detect", () => ({
  isCapacitor: () => isCapacitorMock(),
}))

const hasWebCompanionTargetMock = jest.fn().mockReturnValue(false)
jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => hasWebCompanionTargetMock(),
}))

const hydrateSessionHistoryMock = jest.fn()
jest.mock("@/lib/sync/session-history", () => ({
  hydrateSessionHistory: (...args: unknown[]) => hydrateSessionHistoryMock(...args),
}))

const enqueueHostStateIntentMock = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: (...args: unknown[]) => enqueueHostStateIntentMock(...args),
}))

jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: jest.fn(), subscribe: jest.fn() },
}))
const companionTransportMock = (
  jest.requireMock("@/lib/tauri/transport-instance") as {
    transport: { call: jest.Mock; subscribe: jest.Mock }
  }
).transport

const mockProjectState = {
  activeProjectId: null as string | null,
  loaded: false,
  projects: [],
  addSessionToProject: jest.fn(),
}
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: Object.assign(
    <T>(selector: (s: typeof mockProjectState) => T): T => selector(mockProjectState),
    { getState: () => mockProjectState }
  ),
}))

jest.mock("@/lib/plugin/messaging/message-bus", () => {
  const actual = jest.requireActual("@/lib/plugin/messaging/message-bus")
  return { ...actual, emitSystemBusEvent: jest.fn() }
})

import { useSessions } from "./use-sessions"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"

const mockedEmit = emitSystemBusEvent as jest.Mock

beforeEach(() => {
  liveQueryMock.mockReset().mockReturnValue([])
  listMessagesMock.mockReset().mockResolvedValue([])
  persistMessagesMock.mockReset().mockResolvedValue(undefined)
  createSessionMock.mockReset()
  deleteSessionMock.mockReset().mockResolvedValue(undefined)
  bulkDeleteSessionsMock.mockReset().mockResolvedValue(undefined)
  listSessionsMock.mockReset().mockResolvedValue([])
  listAllSessionsMock.mockReset().mockResolvedValue([])
  updateSessionMock.mockReset().mockResolvedValue(undefined)
  getSessionMock.mockReset().mockResolvedValue({ id: "s1" })
  archiveSessionMock.mockReset().mockResolvedValue(undefined)
  unarchiveSessionMock.mockReset().mockResolvedValue(undefined)
  bulkArchiveSessionsMock.mockReset().mockResolvedValue(undefined)
  bulkUnarchiveSessionsMock.mockReset().mockResolvedValue(undefined)
  bulkSetSessionsPinnedMock.mockReset().mockResolvedValue(undefined)
  assignSessionToFolderMock.mockReset().mockResolvedValue(undefined)
  listFoldersMock.mockReset().mockResolvedValue([])
  createFolderDbMock.mockReset().mockResolvedValue({ id: "f-new" })
  renameFolderDbMock.mockReset().mockResolvedValue(undefined)
  deleteFolderDbMock.mockReset().mockResolvedValue(undefined)
  resolveCharacterByIdMock.mockReset().mockResolvedValue(undefined)
  closeSessionIpcMock.mockReset().mockResolvedValue(undefined)
  chatStoreState.setActiveSession.mockClear()
  chatStoreState.setMessages.mockClear()
  chatStoreState.setMessagesLoadError.mockClear()
  chatStoreState.hydrateSessionActiveBranches.mockClear()
  chatStoreState.activeSessionId = null
  isTauriMock.mockReset().mockReturnValue(true)
  isCapacitorMock.mockReset().mockReturnValue(false)
  hasWebCompanionTargetMock.mockReset().mockReturnValue(false)
  hydrateSessionHistoryMock.mockReset().mockResolvedValue({
    applied: 0,
    total: 0,
    mode: "legacy",
  })
  enqueueHostStateIntentMock.mockReset().mockResolvedValue(null)
  mockProjectState.activeProjectId = null
  mockProjectState.loaded = false
  mockProjectState.addSessionToProject.mockReset()
  mockedEmit.mockClear()
})

describe("useSessions", () => {
  it("does not query scoped sessions before the project store has an active project", () => {
    liveQueryMock.mockImplementation((fn) => fn())
    mockProjectState.loaded = false
    mockProjectState.activeProjectId = null

    renderHook(() => useSessions())

    expect(listSessionsMock).not.toHaveBeenCalled()
  })

  it("queries scoped sessions with the active project after project hydration", () => {
    liveQueryMock.mockImplementation((fn) => fn())
    mockProjectState.loaded = true
    mockProjectState.activeProjectId = "project-default"

    renderHook(() => useSessions())

    expect(listSessionsMock).toHaveBeenCalledWith("project-default")
  })

  it("reads every workspace's sessions in crossWorkspace mode", () => {
    liveQueryMock.mockImplementation((fn) => fn())
    mockProjectState.loaded = true
    mockProjectState.activeProjectId = "project-default"

    renderHook(() => useSessions({ crossWorkspace: true }))

    expect(listAllSessionsMock).toHaveBeenCalled()
    expect(listSessionsMock).not.toHaveBeenCalled()
  })

  it("still treats a foreign-workspace active session as absent in crossWorkspace mode", async () => {
    // "Belongs to another workspace" is what re-points the chat pane after a
    // workspace switch; a cross-workspace list would otherwise resolve the row
    // and strand the previous workspace's conversation on screen.
    mockProjectState.loaded = true
    mockProjectState.activeProjectId = "project-a"
    chatStoreState.activeSessionId = "s-foreign"
    getSessionMock.mockResolvedValue({ id: "s-foreign", projectId: "project-b" })
    liveQueryMock.mockReturnValue([{ id: "s-foreign", kind: "direct", projectId: "project-b" }])

    const { result } = renderHook(() => useSessions({ crossWorkspace: true }))

    await waitFor(() => expect(result.current.activeSessionState).toBe("absent"))
    expect(result.current.activeSession).toBeNull()
  })

  it("resolves an active session from the current workspace in crossWorkspace mode", async () => {
    mockProjectState.loaded = true
    mockProjectState.activeProjectId = "project-a"
    chatStoreState.activeSessionId = "s-local"
    liveQueryMock.mockReturnValue([{ id: "s-local", kind: "direct", projectId: "project-a" }])

    const { result } = renderHook(() => useSessions({ crossWorkspace: true }))

    await waitFor(() => expect(result.current.activeSessionState).toBe("present"))
  })

  it("returns sessions from useLiveQuery (or [] when undefined)", () => {
    mockProjectState.loaded = true
    mockProjectState.activeProjectId = "project-default"
    liveQueryMock.mockReturnValue([{ id: "s1" }])
    const { result } = renderHook(() => useSessions())
    expect(result.current.sessions).toEqual([{ id: "s1" }])
  })

  it("excludes embedded resource sessions from ordinary lists and command palettes", () => {
    mockProjectState.loaded = true
    mockProjectState.activeProjectId = "project-default"
    liveQueryMock.mockReturnValue([
      { id: "ordinary", kind: "direct" },
      { id: "resource", kind: "resource-workbench", visibility: "embedded" },
      { id: "workflow", kind: "workflow-editor", visibility: "embedded" },
    ])

    const { result } = renderHook(() => useSessions())

    expect(result.current.sessions).toEqual([{ id: "ordinary", kind: "direct" }])
  })

  it("reports isLoadingSessions until the first live query resolves", () => {
    liveQueryMock.mockReturnValue(undefined)
    const { result, rerender } = renderHook(() => useSessions())
    expect(result.current.isLoadingSessions).toBe(true)
    expect(result.current.sessions).toEqual([])

    liveQueryMock.mockReturnValue([{ id: "s1" }])
    rerender()
    expect(result.current.isLoadingSessions).toBe(false)
    expect(result.current.sessions).toEqual([{ id: "s1" }])
  })

  it("hydrates messages when activeSessionId changes", async () => {
    chatStoreState.activeSessionId = "s1"
    listMessagesMock.mockResolvedValueOnce([{ id: "m1" }])
    renderHook(() => useSessions())
    await waitFor(() => expect(chatStoreState.setMessages).toHaveBeenCalledWith([{ id: "m1" }]))
    expect(chatStoreState.hydrateSessionActiveBranches).toHaveBeenCalledWith("s1", {})
  })

  it("unfolds complete cloud history before publishing the active session", async () => {
    chatStoreState.activeSessionId = "s1"
    isTauriMock.mockReturnValue(false)
    hasWebCompanionTargetMock.mockReturnValue(true)
    listMessagesMock
      .mockResolvedValueOnce([{ id: "recent-tail" }])
      .mockResolvedValueOnce([{ id: "old" }, { id: "recent-tail" }])

    renderHook(() => useSessions())

    await waitFor(() =>
      expect(chatStoreState.setMessages).toHaveBeenCalledWith([
        { id: "old" },
        { id: "recent-tail" },
      ])
    )
    expect(hydrateSessionHistoryMock).toHaveBeenCalledWith(companionTransportMock, "s1")
  })

  it("keeps the bounded synced tail when the host supports transcript pages", async () => {
    chatStoreState.activeSessionId = "s1"
    isTauriMock.mockReturnValue(false)
    hasWebCompanionTargetMock.mockReturnValue(true)
    listMessagesMock.mockResolvedValueOnce([{ id: "recent-tail" }])
    hydrateSessionHistoryMock.mockResolvedValueOnce({ applied: 0, total: 0, mode: "timeline" })

    renderHook(() => useSessions())

    await waitFor(() =>
      expect(chatStoreState.setMessages).toHaveBeenCalledWith([{ id: "recent-tail" }])
    )
    expect(listMessagesMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { platform: "Tauri", tauri: true, capacitor: false },
    { platform: "Capacitor", tauri: false, capacitor: true },
  ])(
    "does not unfold cloud history through the wrong transport on $platform",
    async ({ tauri, capacitor }) => {
      chatStoreState.activeSessionId = "s1"
      isTauriMock.mockReturnValue(tauri)
      isCapacitorMock.mockReturnValue(capacitor)
      hasWebCompanionTargetMock.mockReturnValue(true)
      listMessagesMock.mockResolvedValueOnce([{ id: "local" }])

      renderHook(() => useSessions())

      await waitFor(() =>
        expect(chatStoreState.setMessages).toHaveBeenCalledWith([{ id: "local" }])
      )
      expect(hydrateSessionHistoryMock).not.toHaveBeenCalled()
    }
  )

  it("does not hydrate when activeSessionId is null", () => {
    chatStoreState.activeSessionId = null
    renderHook(() => useSessions())
    expect(listMessagesMock).not.toHaveBeenCalled()
  })

  it("seeds the character opening message for an empty session", async () => {
    chatStoreState.activeSessionId = "s1"
    listMessagesMock.mockResolvedValueOnce([])
    getSessionMock.mockResolvedValueOnce({ id: "s1", characterId: "c1" })
    resolveCharacterByIdMock.mockResolvedValueOnce({
      id: "c1",
      name: "Tutor",
      persona: { openingMessage: "Welcome aboard!" },
    })
    renderHook(() => useSessions())
    await waitFor(() => expect(persistMessagesMock).toHaveBeenCalledTimes(1))
    const [persistedId, persistedMsgs] = persistMessagesMock.mock.calls[0]
    expect(persistedId).toBe("s1")
    expect(persistedMsgs[0].parts).toEqual([
      { type: "text", text: "Welcome aboard!", state: "done" },
    ])
    expect(chatStoreState.setMessages).toHaveBeenCalledWith(persistedMsgs)
  })

  it("does not seed when the session is empty but has no character opening message", async () => {
    chatStoreState.activeSessionId = "s1"
    listMessagesMock.mockResolvedValueOnce([])
    getSessionMock.mockResolvedValueOnce({ id: "s1", characterId: "c1" })
    resolveCharacterByIdMock.mockResolvedValueOnce({ id: "c1", name: "Tutor", persona: {} })
    renderHook(() => useSessions())
    await waitFor(() => expect(chatStoreState.setMessages).toHaveBeenCalledWith([]))
    expect(persistMessagesMock).not.toHaveBeenCalled()
  })

  it("does not seed an empty session with no character", async () => {
    chatStoreState.activeSessionId = "s1"
    listMessagesMock.mockResolvedValueOnce([])
    getSessionMock.mockResolvedValueOnce({ id: "s1" })
    renderHook(() => useSessions())
    await waitFor(() => expect(chatStoreState.setMessages).toHaveBeenCalledWith([]))
    expect(resolveCharacterByIdMock).not.toHaveBeenCalled()
    expect(persistMessagesMock).not.toHaveBeenCalled()
  })

  it("select forwards to chat store", () => {
    const { result } = renderHook(() => useSessions())
    act(() => result.current.select("s2"))
    expect(chatStoreState.setActiveSession).toHaveBeenCalledWith("s2")
  })

  it("select emits SESSION_SWITCHED on the plugin bus (and skips it for null)", () => {
    const { result } = renderHook(() => useSessions())
    act(() => result.current.select("s2"))
    expect(mockedEmit).toHaveBeenCalledWith(SystemEvents.SESSION_SWITCHED, { sessionId: "s2" })
    mockedEmit.mockClear()
    act(() => result.current.select(null))
    expect(mockedEmit).not.toHaveBeenCalled()
  })

  it("create emits SESSION_CREATED on the plugin bus", async () => {
    createSessionMock.mockResolvedValueOnce({ id: "s-new" })
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.create({ title: "T" } as never)
    })
    expect(mockedEmit).toHaveBeenCalledWith(SystemEvents.SESSION_CREATED, { sessionId: "s-new" })
  })

  it("remove emits SESSION_DELETED on the plugin bus", async () => {
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.remove("s1")
    })
    expect(mockedEmit).toHaveBeenCalledWith(SystemEvents.SESSION_DELETED, { sessionId: "s1" })
  })

  it("bulkRemove emits SESSION_DELETED for each removed session", async () => {
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.bulkRemove(["s1", "s2"])
    })
    expect(mockedEmit).toHaveBeenCalledWith(SystemEvents.SESSION_DELETED, { sessionId: "s1" })
    expect(mockedEmit).toHaveBeenCalledWith(SystemEvents.SESSION_DELETED, { sessionId: "s2" })
  })

  it("create returns the new session and sets it as active", async () => {
    createSessionMock.mockResolvedValueOnce({ id: "s-new" })
    const { result } = renderHook(() => useSessions())
    let session: unknown
    await act(async () => {
      session = await result.current.create({ title: "T" } as never)
    })
    expect((session as { id: string }).id).toBe("s-new")
    expect(chatStoreState.setActiveSession).toHaveBeenCalledWith("s-new")
  })

  it("create auto-links the new session to the active workspace", async () => {
    mockProjectState.activeProjectId = "ws-1"
    createSessionMock.mockResolvedValueOnce({ id: "s-new" })
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.create({ title: "T" } as never)
    })
    expect(mockProjectState.addSessionToProject).toHaveBeenCalledWith("ws-1", "s-new")
  })

  it("create does not link when no workspace is active", async () => {
    mockProjectState.activeProjectId = null
    createSessionMock.mockResolvedValueOnce({ id: "s-new" })
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.create({ title: "T" } as never)
    })
    expect(mockProjectState.addSessionToProject).not.toHaveBeenCalled()
  })

  it("remove tears down the IPC session and deletes the row", async () => {
    chatStoreState.activeSessionId = "s1"
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.remove("s1")
    })
    expect(closeSessionIpcMock).toHaveBeenCalledWith("s1")
    expect(deleteSessionMock).toHaveBeenCalledWith("s1")
    expect(chatStoreState.setActiveSession).toHaveBeenCalledWith(null)
  })

  it("remove tolerates IPC closeSession failures", async () => {
    closeSessionIpcMock.mockRejectedValueOnce(new Error("ipc"))
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.remove("s1")
    })
    expect(deleteSessionMock).toHaveBeenCalledWith("s1")
  })

  it("remove skips closeSession outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.remove("s1")
    })
    expect(closeSessionIpcMock).not.toHaveBeenCalled()
  })

  it("rename forwards to updateSession and opts out of auto-title generation", async () => {
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.rename("s1", "Hi")
    })
    expect(updateSessionMock).toHaveBeenCalledWith("s1", { title: "Hi", titleAuto: false })
  })

  it("routes attached rename and archive mutations through the durable HostState outbox", async () => {
    enqueueHostStateIntentMock.mockResolvedValue({ id: "queued", status: "pending" })
    const { result } = renderHook(() => useSessions())

    await act(async () => {
      await result.current.rename("s1", "Host title")
      await result.current.archive("s1")
      await result.current.unarchive("s2")
    })

    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith({
      sessionId: "s1",
      action: { kind: "session.rename", title: "Host title" },
    })
    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith({
      sessionId: "s1",
      action: { kind: "session.archive", archived: true },
    })
    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith({
      sessionId: "s2",
      action: { kind: "session.archive", archived: false },
    })
    expect(updateSessionMock).not.toHaveBeenCalled()
    expect(archiveSessionMock).not.toHaveBeenCalled()
    expect(unarchiveSessionMock).not.toHaveBeenCalled()
  })

  it("bulkRemove tears down every session via IPC then deletes them in one Dexie tx", async () => {
    chatStoreState.activeSessionId = "s2"
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.bulkRemove(["s1", "s2", "s3"])
    })
    expect(closeSessionIpcMock).toHaveBeenCalledTimes(3)
    expect(bulkDeleteSessionsMock).toHaveBeenCalledWith(["s1", "s2", "s3"])
    expect(chatStoreState.setActiveSession).toHaveBeenCalledWith(null)
  })

  it("bulkRemove leaves the active session pointer alone when it is not in the ids list", async () => {
    chatStoreState.activeSessionId = "untouched"
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.bulkRemove(["s1", "s2"])
    })
    expect(chatStoreState.setActiveSession).not.toHaveBeenCalledWith(null)
  })

  it("bulkRemove skips closeSession outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.bulkRemove(["s1"])
    })
    expect(closeSessionIpcMock).not.toHaveBeenCalled()
    expect(bulkDeleteSessionsMock).toHaveBeenCalledWith(["s1"])
  })

  it("bulkRemove on an empty array is a no-op (no Dexie call, no IPC call)", async () => {
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.bulkRemove([])
    })
    expect(bulkDeleteSessionsMock).not.toHaveBeenCalled()
    expect(closeSessionIpcMock).not.toHaveBeenCalled()
  })

  it("bulkSetPinned delegates the whole selection to the atomic database operation", async () => {
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.bulkSetPinned(["s1", "s2"], true)
    })
    expect(bulkSetSessionsPinnedMock).toHaveBeenCalledWith(["s1", "s2"], true)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it("bulkSetPinned on an empty array does not touch Dexie", async () => {
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.bulkSetPinned([], false)
    })
    expect(bulkSetSessionsPinnedMock).not.toHaveBeenCalled()
  })

  it("archive stamps the row and deselects it when it is the active session", async () => {
    chatStoreState.activeSessionId = "s1"
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.archive("s1")
    })
    expect(archiveSessionMock).toHaveBeenCalledWith("s1")
    expect(chatStoreState.setActiveSession).toHaveBeenCalledWith(null)
  })

  it("archive leaves the active pointer alone for a non-active session", async () => {
    chatStoreState.activeSessionId = "other"
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.archive("s1")
    })
    expect(archiveSessionMock).toHaveBeenCalledWith("s1")
    expect(chatStoreState.setActiveSession).not.toHaveBeenCalled()
  })

  it("unarchive clears the archive marker", async () => {
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.unarchive("s1")
    })
    expect(unarchiveSessionMock).toHaveBeenCalledWith("s1")
  })

  it("bulkUnarchive delegates to the transactional db helper", async () => {
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.bulkUnarchive(["s1", "s2"])
    })
    expect(bulkUnarchiveSessionsMock).toHaveBeenCalledWith(["s1", "s2"])
  })

  it("bulkArchive archives every id and deselects the active one", async () => {
    chatStoreState.activeSessionId = "s2"
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.bulkArchive(["s1", "s2"])
    })
    expect(bulkArchiveSessionsMock).toHaveBeenCalledWith(["s1", "s2"])
    expect(chatStoreState.setActiveSession).toHaveBeenCalledWith(null)
  })

  it("bulkArchive on an empty array is a no-op", async () => {
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.bulkArchive([])
    })
    expect(bulkArchiveSessionsMock).not.toHaveBeenCalled()
  })

  it("exposes folder CRUD that delegates to the folders data layer", async () => {
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.createFolder("Work")
      await result.current.renameFolder("f1", "Renamed")
      await result.current.deleteFolder("f1")
      await result.current.assignToFolder("s1", "f1")
      await result.current.assignToFolder("s1", null)
    })
    expect(createFolderDbMock).toHaveBeenCalledWith("Work")
    expect(renameFolderDbMock).toHaveBeenCalledWith("f1", "Renamed")
    expect(deleteFolderDbMock).toHaveBeenCalledWith("f1")
    expect(assignSessionToFolderMock).toHaveBeenCalledWith("s1", "f1")
    expect(assignSessionToFolderMock).toHaveBeenCalledWith("s1", null)
  })
})
