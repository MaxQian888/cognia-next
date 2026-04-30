/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const liveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(fn: () => Promise<T> | T): T | undefined => liveQueryMock(fn) as T | undefined,
}))

const listMessagesMock = jest.fn()
jest.mock("@/lib/db/messages", () => ({
  listMessages: (id: string) => listMessagesMock(id),
}))

const createSessionMock = jest.fn()
const deleteSessionMock = jest.fn()
const listSessionsMock = jest.fn()
const updateSessionMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  createSession: (p: unknown) => createSessionMock(p),
  deleteSession: (id: string) => deleteSessionMock(id),
  listSessions: () => listSessionsMock(),
  updateSession: (id: string, p: unknown) => updateSessionMock(id, p),
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
  activeSessionId: null as string | null,
}

jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(
    <T>(selector: (s: typeof chatStoreState) => T): T => selector(chatStoreState),
    {
      getState: () => chatStoreState,
    }
  ),
}))

const isTauriMock = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

import { useSessions } from "./use-sessions"

beforeEach(() => {
  liveQueryMock.mockReset().mockReturnValue([])
  listMessagesMock.mockReset().mockResolvedValue([])
  createSessionMock.mockReset()
  deleteSessionMock.mockReset().mockResolvedValue(undefined)
  listSessionsMock.mockReset().mockResolvedValue([])
  updateSessionMock.mockReset().mockResolvedValue(undefined)
  closeSessionIpcMock.mockReset().mockResolvedValue(undefined)
  chatStoreState.setActiveSession.mockClear()
  chatStoreState.setMessages.mockClear()
  chatStoreState.activeSessionId = null
  isTauriMock.mockReset().mockReturnValue(true)
})

describe("useSessions", () => {
  it("returns sessions from useLiveQuery (or [] when undefined)", () => {
    liveQueryMock.mockReturnValue([{ id: "s1" }])
    const { result } = renderHook(() => useSessions())
    expect(result.current.sessions).toEqual([{ id: "s1" }])
  })

  it("hydrates messages when activeSessionId changes", async () => {
    chatStoreState.activeSessionId = "s1"
    listMessagesMock.mockResolvedValueOnce([{ id: "m1" }])
    renderHook(() => useSessions())
    await waitFor(() => expect(chatStoreState.setMessages).toHaveBeenCalledWith([{ id: "m1" }]))
  })

  it("does not hydrate when activeSessionId is null", () => {
    chatStoreState.activeSessionId = null
    renderHook(() => useSessions())
    expect(listMessagesMock).not.toHaveBeenCalled()
  })

  it("select forwards to chat store", () => {
    const { result } = renderHook(() => useSessions())
    act(() => result.current.select("s2"))
    expect(chatStoreState.setActiveSession).toHaveBeenCalledWith("s2")
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

  it("rename forwards to updateSession", async () => {
    const { result } = renderHook(() => useSessions())
    await act(async () => {
      await result.current.rename("s1", "Hi")
    })
    expect(updateSessionMock).toHaveBeenCalledWith("s1", { title: "Hi" })
  })
})
