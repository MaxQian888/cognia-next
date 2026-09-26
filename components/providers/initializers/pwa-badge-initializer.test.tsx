import { act, render } from "@testing-library/react"

// A hand-driven stand-in for the window's shared unread store: `emit` plays a
// fresh read landing, `listeners` shows who is subscribed.
type Snapshot = { sessions: Array<{ id: string }>; unreadBySession: Map<string, number> } | null
const store: { snapshot: Snapshot; listeners: Set<() => void> } = {
  snapshot: null,
  listeners: new Set(),
}
const unsubscribeMock = jest.fn()
jest.mock("@/lib/chat/unread-sessions", () => ({
  subscribeUnreadSessions: (listener: () => void) => {
    store.listeners.add(listener)
    return () => {
      store.listeners.delete(listener)
      unsubscribeMock()
    }
  },
  getUnreadSessionsSnapshot: () => store.snapshot,
}))
// Counting is pinned in `lib/inbox/unread-count.test.ts`; here one unread row
// is one unread chat.
jest.mock("@/lib/inbox/unread-count", () => ({
  countMobileUnread: (sessions: unknown[]) => ({ chat: sessions.length, inbox: 0 }),
}))

function read(chat: number): Snapshot {
  const sessions = Array.from({ length: chat }, (_, i) => ({ id: `s${i}` }))
  return { sessions, unreadBySession: new Map(sessions.map((row) => [row.id, 1])) }
}

function emit(next: Snapshot): void {
  store.snapshot = next
  for (const listener of [...store.listeners]) listener()
}

const applyBadgeMock = jest.fn<boolean, [number]>(() => true)
jest.mock("@/lib/pwa/app-badge", () => ({
  applyAppBadge: (n: number) => applyBadgeMock(n),
}))

let standalone = true
jest.mock("@/lib/pwa/install-state", () => ({
  isStandaloneDisplayMode: () => standalone,
}))

const detectPlatformMock = jest.fn(() => "web")
jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => detectPlatformMock(),
}))

import { PwaBadgeInitializer } from "./pwa-badge-initializer"

interface MediaStub {
  matches: boolean
  media: string
  fire: () => void
}
const mediaHandlers = new Map<string, Set<() => void>>()

function stubMatchMedia(): void {
  mediaHandlers.clear()
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: jest.fn((query: string) => {
      const stub: MediaStub = {
        matches: standalone,
        media: query,
        fire: () => {
          for (const cb of mediaHandlers.get(query) ?? []) cb()
        },
      }
      return {
        ...stub,
        addEventListener: (_t: string, cb: () => void) => {
          const bucket = mediaHandlers.get(query) ?? new Set<() => void>()
          bucket.add(cb)
          mediaHandlers.set(query, bucket)
        },
        removeEventListener: (_t: string, cb: () => void) => {
          mediaHandlers.get(query)?.delete(cb)
        },
      }
    }),
  })
}

beforeEach(() => {
  standalone = true
  store.snapshot = null
  store.listeners.clear()
  unsubscribeMock.mockClear()
  applyBadgeMock.mockClear()
  detectPlatformMock.mockReturnValue("web")
  stubMatchMedia()
})

describe("<PwaBadgeInitializer />", () => {
  it("paints the shared unread read once it lands", () => {
    render(<PwaBadgeInitializer />)
    expect(store.listeners.size).toBe(1)
    // Nothing read yet: the icon is left alone rather than cleared.
    expect(applyBadgeMock).not.toHaveBeenCalled()
    act(() => emit(read(4)))
    expect(applyBadgeMock).toHaveBeenLastCalledWith(4)
  })

  it("paints at once when the store is already warm", () => {
    store.snapshot = read(2)
    render(<PwaBadgeInitializer />)
    expect(applyBadgeMock).toHaveBeenCalledWith(2)
  })

  it("repaints when a new read lands, and clears at zero", () => {
    render(<PwaBadgeInitializer />)
    act(() => emit(read(7)))
    expect(applyBadgeMock).toHaveBeenLastCalledWith(7)
    act(() => emit(read(0)))
    expect(applyBadgeMock).toHaveBeenLastCalledWith(0)
  })

  it("does not subscribe outside standalone windows", () => {
    standalone = false
    render(<PwaBadgeInitializer />)
    expect(store.listeners.size).toBe(0)
    expect(applyBadgeMock).not.toHaveBeenCalled()
  })

  it("starts when the window flips into standalone mid-session", () => {
    standalone = false
    render(<PwaBadgeInitializer />)
    expect(store.listeners.size).toBe(0)
    standalone = true
    act(() => {
      for (const cb of mediaHandlers.get("(display-mode: standalone)") ?? []) cb()
    })
    expect(store.listeners.size).toBe(1)
  })

  it("is a no-op off the web shell", () => {
    detectPlatformMock.mockReturnValue("tauri")
    render(<PwaBadgeInitializer />)
    expect(store.listeners.size).toBe(0)
  })

  it("unsubscribes on unmount", () => {
    const { unmount } = render(<PwaBadgeInitializer />)
    expect(store.listeners.size).toBe(1)
    unmount()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
    expect(store.listeners.size).toBe(0)
  })
})
