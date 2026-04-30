/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

const isTauriMock = jest.fn().mockReturnValue(true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const notifyMock = jest.fn()
jest.mock("@/lib/tauri/notification", () => ({
  notify: (args: unknown) => notifyMock(args),
}))

interface ChatState {
  status: string
  errorMessage?: string
}
let _chatState: ChatState = { status: "idle" }
const subscribers: Array<(s: ChatState, prev?: ChatState) => void> = []

jest.mock("@/stores/chat", () => ({
  useChatStore: {
    subscribe: (fn: (s: ChatState, prev?: ChatState) => void) => {
      subscribers.push(fn)
      return () => {
        const i = subscribers.indexOf(fn)
        if (i >= 0) subscribers.splice(i, 1)
      }
    },
  },
}))

import { useSessionNotifications } from "./use-session-notifications"

beforeEach(() => {
  isTauriMock.mockReset().mockReturnValue(true)
  notifyMock.mockClear()
  subscribers.length = 0
  _chatState = { status: "idle" }
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    writable: true,
    value: jest.fn(() => false),
  })
})

describe("useSessionNotifications", () => {
  it("non-Tauri: doesn't subscribe", () => {
    isTauriMock.mockReturnValue(false)
    renderHook(() => useSessionNotifications())
    expect(subscribers.length).toBe(0)
  })

  it("streaming → idle while window unfocused fires success notify", () => {
    renderHook(() => useSessionNotifications())
    const next: ChatState = { status: "idle" }
    const prev: ChatState = { status: "streaming" }
    subscribers[0]?.(next, prev)
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("response ready"),
      })
    )
  })

  it("streaming → error fires error notify", () => {
    renderHook(() => useSessionNotifications())
    const next: ChatState = { status: "error", errorMessage: "kaboom" }
    const prev: ChatState = { status: "streaming" }
    subscribers[0]?.(next, prev)
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("session error"),
        body: "kaboom",
      })
    )
  })

  it("ignores transitions that don't end streaming", () => {
    renderHook(() => useSessionNotifications())
    subscribers[0]?.({ status: "streaming" }, { status: "idle" })
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it("suppresses notify when window is focused", () => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      writable: true,
      value: () => true,
    })
    renderHook(() => useSessionNotifications())
    subscribers[0]?.({ status: "idle" }, { status: "streaming" })
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useSessionNotifications())
    expect(subscribers.length).toBe(1)
    unmount()
    expect(subscribers.length).toBe(0)
  })
})
