import { useUnreadMarkerStore } from "@/stores/chat/unread-marker-store"
import {
  captureUnreadMarker,
  dropUnreadMarker,
  firstUnreadMessageId,
  openSessionForReading,
  type UnreadMarkerDeps,
} from "./unread-marker"

jest.mock("@/lib/db/session-state", () => ({
  getSessionState: jest.fn(),
  markSessionRead: jest.fn(),
}))

const msg = (id: string, createdAt?: number) => ({
  id,
  ...(createdAt !== undefined ? { metadata: { createdAt } } : {}),
})

describe("firstUnreadMessageId", () => {
  it("returns the first message newer than the marker, counting in-flight ones as new", () => {
    const messages = [msg("a", 10), msg("b", 20), msg("c", 30)]
    expect(firstUnreadMessageId(messages, 15)).toBe("b")
    expect(firstUnreadMessageId(messages, 30)).toBeNull()
    expect(firstUnreadMessageId(messages, null)).toBeNull()
    expect(firstUnreadMessageId([msg("a", 10), msg("live")], 10)).toBe("live")
    expect(firstUnreadMessageId([], 5)).toBeNull()
  })
})

describe("captureUnreadMarker / openSessionForReading", () => {
  const deps = (state: { lastReadAt: number; unreadCount: number } | undefined) => {
    const calls: string[] = []
    const d: UnreadMarkerDeps = {
      getSessionState: async () => {
        calls.push("get")
        return state ? { sessionId: "s1", ...state } : undefined
      },
      markSessionRead: async () => {
        calls.push("mark")
      },
      setMarker: (sessionId, lastReadAt) => calls.push(`set:${sessionId}:${lastReadAt}`),
    }
    return { d, calls }
  }

  it("records the old pointer only when something was unread", async () => {
    const unread = deps({ lastReadAt: 100, unreadCount: 3 })
    expect(await captureUnreadMarker("s1", unread.d)).toBe(100)
    expect(unread.calls).toEqual(["get", "set:s1:100"])
    const read = deps({ lastReadAt: 100, unreadCount: 0 })
    expect(await captureUnreadMarker("s1", read.d)).toBeNull()
    expect(read.calls).toEqual(["get", "set:s1:null"])
    const never = deps(undefined)
    expect(await captureUnreadMarker("s1", never.d)).toBeNull()
    // A row whose pointer was never set (only bumped) cannot place a divider.
    const bumpedOnly = deps({ lastReadAt: 0, unreadCount: 2 })
    expect(await captureUnreadMarker("s1", bumpedOnly.d)).toBeNull()
  })

  it("captures before it marks read, so the pointer survives the open", async () => {
    const { d, calls } = deps({ lastReadAt: 100, unreadCount: 1 })
    await openSessionForReading("s1", d)
    expect(calls).toEqual(["get", "set:s1:100", "mark"])
  })

  it("writes the store by default and drops the marker on demand", async () => {
    useUnreadMarkerStore.setState({ markers: {} })
    const { getSessionState } = jest.requireMock("@/lib/db/session-state") as {
      getSessionState: jest.Mock
    }
    getSessionState.mockResolvedValueOnce({ sessionId: "s1", lastReadAt: 42, unreadCount: 1 })
    await captureUnreadMarker("s1")
    expect(useUnreadMarkerStore.getState().markers).toEqual({ s1: 42 })
    dropUnreadMarker("s1")
    expect(useUnreadMarkerStore.getState().markers).toEqual({})
  })
})
