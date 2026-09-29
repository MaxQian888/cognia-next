/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

const notifyMock = jest.fn()
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (args: unknown) => notifyMock(args),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const getSessionMock = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  getSession: (id: string) => getSessionMock(id),
}))

interface Slice {
  status: string
  errorMessage?: string | null
}
interface ChatState {
  sessions: Record<string, Slice>
  activeSessionId: string | null
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

import { sessionNotificationEvents, useSessionNotifications } from "./use-session-notifications"

function setFocus(focused: boolean) {
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    writable: true,
    value: jest.fn(() => focused),
  })
}

function emit(next: ChatState, prev: ChatState) {
  subscribers[0]?.(next, prev)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  notifyMock.mockClear()
  getSessionMock.mockReset().mockResolvedValue({ id: "s1", title: "Fix the build" })
  subscribers.length = 0
  setFocus(false)
})

describe("sessionNotificationEvents", () => {
  it("reports finished, failed and waiting sessions", () => {
    expect(
      sessionNotificationEvents(
        { a: { status: "streaming" }, b: { status: "streaming" }, c: { status: "streaming" } },
        {
          a: { status: "idle", errorMessage: null },
          b: { status: "error", errorMessage: "boom" },
          c: { status: "awaiting_approval", errorMessage: null },
        },
        null
      )
    ).toEqual([
      { sessionId: "a", kind: "finished" },
      { sessionId: "b", kind: "error", errorMessage: "boom" },
      { sessionId: "c", kind: "approval" },
    ])
  })

  it("skips the session the user is watching and non-terminal moves", () => {
    expect(
      sessionNotificationEvents(
        { a: { status: "streaming" }, b: { status: "idle" } },
        {
          a: { status: "idle", errorMessage: null },
          b: { status: "streaming", errorMessage: null },
        },
        "a"
      )
    ).toEqual([])
  })

  it("treats a session that just appeared as coming from idle", () => {
    expect(
      sessionNotificationEvents(
        undefined,
        { a: { status: "awaiting_approval", errorMessage: null } },
        null
      )
    ).toEqual([{ sessionId: "a", kind: "approval" }])
    expect(
      sessionNotificationEvents({}, { a: { status: "idle", errorMessage: null } }, null)
    ).toEqual([])
  })
})

describe("useSessionNotifications", () => {
  it("notifies an OS banner when a background session finishes while the window is away", async () => {
    renderHook(() => useSessionNotifications())
    emit(
      { sessions: { s1: { status: "idle" } }, activeSessionId: "s1" },
      { sessions: { s1: { status: "streaming" } }, activeSessionId: "s1" }
    )
    await flush()
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "session",
        level: "success",
        title: "readyTitle",
        body: 'readyBodyNamed:{"title":"Fix the build"}',
        channels: ["center", "os"],
        sourceRef: { kind: "session", id: "s1" },
        href: expect.stringContaining("s1"),
      })
    )
  })

  it("does not notify for the session on screen in a focused window", async () => {
    setFocus(true)
    renderHook(() => useSessionNotifications())
    emit(
      { sessions: { s1: { status: "idle" } }, activeSessionId: "s1" },
      { sessions: { s1: { status: "streaming" } }, activeSessionId: "s1" }
    )
    await flush()
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it("toasts a held background session asking for approval while the window is focused", async () => {
    setFocus(true)
    renderHook(() => useSessionNotifications())
    emit(
      {
        sessions: { s1: { status: "idle" }, t1: { status: "awaiting_approval" } },
        activeSessionId: "s1",
      },
      { sessions: { s1: { status: "idle" }, t1: { status: "streaming" } }, activeSessionId: "s1" }
    )
    await flush()
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        title: "approvalTitle",
        directed: true,
        channels: ["center", "toast"],
        dedupeKey: "session-approval:t1",
      })
    )
  })

  it("reports the error text, and falls back to unnamed copy when the title is unknown", async () => {
    getSessionMock.mockRejectedValue(new Error("gone"))
    renderHook(() => useSessionNotifications())
    emit(
      { sessions: { s1: { status: "error", errorMessage: null } }, activeSessionId: null },
      { sessions: { s1: { status: "streaming" } }, activeSessionId: null }
    )
    await flush()
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "errorTitle", body: "errorBody" })
    )
  })

  it("ignores updates that leave the session map untouched", async () => {
    renderHook(() => useSessionNotifications())
    const sessions = { s1: { status: "idle" } }
    emit({ sessions, activeSessionId: null }, { sessions, activeSessionId: "s1" })
    await flush()
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useSessionNotifications())
    expect(subscribers).toHaveLength(1)
    unmount()
    expect(subscribers).toHaveLength(0)
  })
})
