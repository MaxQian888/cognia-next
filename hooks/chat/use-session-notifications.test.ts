/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

const notifyMock = jest.fn()
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (args: unknown) => notifyMock(args),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

interface ChatState {
  status: string
  errorMessage?: string
}
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
  notifyMock.mockClear()
  subscribers.length = 0
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    writable: true,
    value: jest.fn(() => false),
  })
})

describe("useSessionNotifications", () => {
  it("subscribes on mount (records to the center on any platform)", () => {
    renderHook(() => useSessionNotifications())
    expect(subscribers.length).toBe(1)
  })

  it("streaming → idle while unfocused fires a success notification via the center", () => {
    renderHook(() => useSessionNotifications())
    subscribers[0]?.({ status: "idle" }, { status: "streaming" })
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "session",
        level: "success",
        title: "readyTitle",
        channels: ["center", "os"],
      })
    )
  })

  it("streaming → error fires an error notification with the error body", () => {
    renderHook(() => useSessionNotifications())
    subscribers[0]?.({ status: "error", errorMessage: "kaboom" }, { status: "streaming" })
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "errorTitle", body: "kaboom" })
    )
  })

  it("ignores transitions that don't end streaming", () => {
    renderHook(() => useSessionNotifications())
    subscribers[0]?.({ status: "streaming" }, { status: "idle" })
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it("suppresses the notification when the window is focused", () => {
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
