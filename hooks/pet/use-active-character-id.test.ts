import { renderHook, waitFor } from "@testing-library/react"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))

let activeSessionId: string | null = null
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: { activeSessionId: string | null }) => unknown) =>
    selector({ activeSessionId }),
}))

import { useLiveQuery } from "dexie-react-hooks"
import { getSession } from "@/lib/db/sessions"
import { useActiveCharacterId } from "./use-active-character-id"

const liveQuery = useLiveQuery as jest.Mock
const getSessionMock = getSession as jest.Mock

// Drive the real querier so its branches are exercised, and expose its result.
function runQuerier() {
  let resolved: unknown
  liveQuery.mockImplementation((fn: () => Promise<unknown>) => {
    void Promise.resolve(fn()).then((v) => {
      resolved = v
    })
    return undefined
  })
  return () => resolved
}

beforeEach(() => {
  liveQuery.mockReset()
  getSessionMock.mockReset()
  activeSessionId = null
})

describe("useActiveCharacterId", () => {
  it("returns undefined when there is no active session", async () => {
    activeSessionId = null
    const read = runQuerier()
    renderHook(() => useActiveCharacterId())
    await waitFor(() => expect(read()).toBeUndefined())
    expect(getSessionMock).not.toHaveBeenCalled()
  })

  it("returns the active session's characterId", async () => {
    activeSessionId = "s-1"
    getSessionMock.mockResolvedValue({ id: "s-1", characterId: "char-7" })
    const read = runQuerier()
    renderHook(() => useActiveCharacterId())
    await waitFor(() => expect(read()).toBe("char-7"))
    expect(getSessionMock).toHaveBeenCalledWith("s-1")
  })

  it("returns undefined when the session has no characterId", async () => {
    activeSessionId = "s-2"
    getSessionMock.mockResolvedValue({ id: "s-2" })
    const read = runQuerier()
    renderHook(() => useActiveCharacterId())
    await waitFor(() => expect(read()).toBeUndefined())
  })

  it("returns undefined when the session row is missing", async () => {
    activeSessionId = "s-gone"
    getSessionMock.mockResolvedValue(undefined)
    const read = runQuerier()
    renderHook(() => useActiveCharacterId())
    await waitFor(() => expect(read()).toBeUndefined())
  })

  it("passes the live-query result straight through", () => {
    activeSessionId = "s-1"
    liveQuery.mockReturnValue("char-9")
    const { result } = renderHook(() => useActiveCharacterId())
    expect(result.current).toBe("char-9")
  })
})
