import { act, render, waitFor } from "@testing-library/react"

const liveQuerySubscribers: Array<{
  next: (v: unknown) => void
  error: (e: unknown) => void
}> = []
const unsubscribeMock = jest.fn()
jest.mock("dexie", () => ({
  __esModule: true,
  default: {
    liveQuery: (query: () => Promise<unknown>) => ({
      subscribe: (handlers: { next: (v: unknown) => void; error: (e: unknown) => void }) => {
        liveQuerySubscribers.push(handlers)
        void query().then(handlers.next)
        return { unsubscribe: unsubscribeMock }
      },
    }),
  },
}))

const loadUnreadMock = jest.fn(async () => ({ chat: 0, inbox: 0 }))
jest.mock("@/lib/inbox/unread-count", () => ({
  loadMobileUnread: () => loadUnreadMock(),
}))

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
  liveQuerySubscribers.length = 0
  unsubscribeMock.mockClear()
  loadUnreadMock.mockClear().mockResolvedValue({ chat: 0, inbox: 0 })
  applyBadgeMock.mockClear()
  detectPlatformMock.mockReturnValue("web")
  stubMatchMedia()
})

describe("<PwaBadgeInitializer />", () => {
  it("subscribes to unread counts and paints the badge", async () => {
    loadUnreadMock.mockResolvedValue({ chat: 4, inbox: 1 })
    render(<PwaBadgeInitializer />)
    await waitFor(() => expect(applyBadgeMock).toHaveBeenCalledWith(4))
  })

  it("repaints when the live query emits a new count", async () => {
    render(<PwaBadgeInitializer />)
    await waitFor(() => expect(liveQuerySubscribers.length).toBe(1))
    act(() => {
      liveQuerySubscribers[0].next({ chat: 7, inbox: 0 })
    })
    await waitFor(() => expect(applyBadgeMock).toHaveBeenCalledWith(7))
  })

  it("does not subscribe outside standalone windows", async () => {
    standalone = false
    render(<PwaBadgeInitializer />)
    await Promise.resolve()
    expect(liveQuerySubscribers.length).toBe(0)
    expect(applyBadgeMock).not.toHaveBeenCalled()
  })

  it("starts when the window flips into standalone mid-session", async () => {
    standalone = false
    render(<PwaBadgeInitializer />)
    await Promise.resolve()
    expect(liveQuerySubscribers.length).toBe(0)
    standalone = true
    act(() => {
      for (const cb of mediaHandlers.get("(display-mode: standalone)") ?? []) cb()
    })
    await waitFor(() => expect(liveQuerySubscribers.length).toBe(1))
  })

  it("is a no-op off the web shell", () => {
    detectPlatformMock.mockReturnValue("tauri")
    render(<PwaBadgeInitializer />)
    expect(liveQuerySubscribers.length).toBe(0)
  })

  it("unsubscribes on unmount", async () => {
    const { unmount } = render(<PwaBadgeInitializer />)
    await waitFor(() => expect(liveQuerySubscribers.length).toBe(1))
    unmount()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })
})
