/** @jest-environment jsdom */

import { act, render, renderHook, screen } from "@testing-library/react"

import type { UnreadBadgeSession, UnreadSessions } from "@/lib/chat/unread-sessions"

// A hand-driven stand-in for the window's shared unread store.
const store: { snapshot: UnreadSessions | null; listeners: Set<() => void>; subscribes: number } = {
  snapshot: null,
  listeners: new Set(),
  subscribes: 0,
}
jest.mock("@/lib/chat/unread-sessions", () => ({
  ...jest.requireActual<typeof import("@/lib/chat/unread-sessions")>("@/lib/chat/unread-sessions"),
  subscribeUnreadSessions: (listener: () => void) => {
    store.subscribes += 1
    store.listeners.add(listener)
    return () => store.listeners.delete(listener)
  },
  getUnreadSessionsSnapshot: () => store.snapshot,
}))
// The real module graph behind `loadUnreadSessions`; never reached here.
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))

import { useMobileUnread, useUnreadSessions } from "./use-unread-sessions"

const badge = (id: string, over: Partial<UnreadBadgeSession> = {}): UnreadBadgeSession => ({
  id,
  kind: "direct",
  ...over,
})

function emit(sessions: UnreadBadgeSession[]): void {
  store.snapshot = { sessions, unreadBySession: new Map(sessions.map((s) => [s.id, 1])) }
  for (const listener of [...store.listeners]) listener()
}

beforeEach(() => {
  store.snapshot = null
  store.listeners.clear()
  store.subscribes = 0
})

describe("useUnreadSessions", () => {
  it("is null until the first read lands, then follows the store", () => {
    const { result } = renderHook(() => useUnreadSessions())
    expect(result.current).toBeNull()
    act(() => emit([badge("a")]))
    expect(result.current?.sessions.map((s) => s.id)).toEqual(["a"])
  })

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useUnreadSessions())
    expect(store.listeners.size).toBe(1)
    unmount()
    expect(store.listeners.size).toBe(0)
  })
})

describe("useMobileUnread", () => {
  it("is zero until the first read lands", () => {
    const { result } = renderHook(() => useMobileUnread())
    expect(result.current).toEqual({ chat: 0, inbox: 0 })
  })

  it("counts the shared read the mobile way", () => {
    const { result } = renderHook(() => useMobileUnread())
    act(() =>
      emit([
        badge("plain"),
        badge("im", { platformConversationKey: "lark:c1" }),
        badge("archived", { archivedAt: 1 }),
      ])
    )
    expect(result.current).toEqual({ chat: 2, inbox: 1 })
  })

  it("keeps one counts object while the read is unchanged", () => {
    const { result, rerender } = renderHook(() => useMobileUnread())
    act(() => emit([badge("a")]))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it("serves every badge in the window from the same store", () => {
    function Badges() {
      const a = useMobileUnread()
      const b = useMobileUnread()
      return (
        <span data-testid="badges">
          {a.chat}/{b.chat}
        </span>
      )
    }
    render(<Badges />)
    act(() => emit([badge("a"), badge("b")]))
    expect(screen.getByTestId("badges")).toHaveTextContent("2/2")
    // Every subscriber hangs off the one store; the refcounted observer
    // behind it is pinned in `lib/chat/unread-sessions.test.ts`.
    expect(store.listeners.size).toBe(2)
  })
})
