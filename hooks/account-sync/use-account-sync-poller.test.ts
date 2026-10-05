/** @jest-environment jsdom */

jest.mock("@/lib/account-sync/approval-notifications", () => ({
  notifyIncomingRequest: jest.fn(async () => "n"),
  clearRequestNotification: jest.fn(async () => {}),
}))
jest.mock("@/lib/account-sync/sync-session", () => ({
  officialSyncSession: jest.fn(async () => null),
}))

import { act, renderHook } from "@testing-library/react"

import {
  clearRequestNotification,
  notifyIncomingRequest,
} from "@/lib/account-sync/approval-notifications"
import type { IncomingRequest } from "@/lib/account-sync/enrollment/approve"
import type { AccountSyncContext } from "@/lib/account-sync/enrollment/context"
import { ACCOUNT_SYNC_POLL_MS, type PollResult } from "@/lib/account-sync/poll"
import { officialSyncSession } from "@/lib/account-sync/sync-session"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { useAccountSyncPoller } from "./use-account-sync-poller"

const context = {} as AccountSyncContext
const request = (requestId: string) =>
  ({ requestId, state: "pending", expiresAt: 1, displayName: "X" }) as IncomingRequest
const text = () => ({ title: "t", body: "b", open: "o" })

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
  document.dispatchEvent(new Event("visibilitychange"))
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  useAccountSyncStore.getState().reset()
  setVisibility("visible")
  jest.clearAllMocks()
})
afterEach(() => jest.useRealTimers())

describe("useAccountSyncPoller", () => {
  it("does nothing at all when disabled", async () => {
    const poll = jest.fn()
    const resolveContext = jest.fn()
    renderHook(() =>
      useAccountSyncPoller({ enabled: false, notificationText: text, poll, resolveContext })
    )
    await act(async () => {
      jest.advanceTimersByTime(10 * ACCOUNT_SYNC_POLL_MS)
    })
    expect(poll).not.toHaveBeenCalled()
    expect(resolveContext).not.toHaveBeenCalled()
    expect(officialSyncSession).not.toHaveBeenCalled()
  })

  it("looks at once, then every 20 s, and stores the result", async () => {
    const poll = jest.fn(async (): Promise<PollResult> => ({
      view: { kind: "signed-out" },
      incoming: [],
    }))
    const resolveContext = jest.fn(async () => context)
    renderHook(() =>
      useAccountSyncPoller({ enabled: true, notificationText: text, poll, resolveContext })
    )
    await act(async () => {
      jest.advanceTimersByTime(0)
    })
    await flush()
    expect(poll).toHaveBeenCalledTimes(1)
    expect(poll).toHaveBeenCalledWith(context)
    expect(useAccountSyncStore.getState().view).toEqual({ kind: "signed-out" })
    await act(async () => {
      jest.advanceTimersByTime(ACCOUNT_SYNC_POLL_MS)
    })
    await flush()
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it("announces a waiting device once and archives the prompt when it ends", async () => {
    const results: PollResult[] = [
      { view: { kind: "signed-out" }, incoming: [request("req_1")] },
      { view: { kind: "signed-out" }, incoming: [request("req_1")] },
      { view: { kind: "signed-out" }, incoming: [] },
    ]
    const poll = jest.fn(
      async () => results.shift() ?? { view: { kind: "signed-out" as const }, incoming: [] }
    )
    renderHook(() =>
      useAccountSyncPoller({
        enabled: true,
        notificationText: text,
        poll,
        resolveContext: async () => context,
      })
    )
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        jest.advanceTimersByTime(i === 0 ? 0 : ACCOUNT_SYNC_POLL_MS)
      })
      await flush()
    }
    expect(notifyIncomingRequest).toHaveBeenCalledTimes(1)
    expect(notifyIncomingRequest).toHaveBeenCalledWith(request("req_1"), {
      title: "t",
      body: "b",
      open: "o",
    })
    expect(clearRequestNotification).toHaveBeenCalledWith("req_1")
  })

  it("stops while hidden and looks again on becoming visible", async () => {
    const poll = jest.fn(async (): Promise<PollResult> => ({
      view: { kind: "signed-out" },
      incoming: [],
    }))
    setVisibility("hidden")
    renderHook(() =>
      useAccountSyncPoller({
        enabled: true,
        notificationText: text,
        poll,
        resolveContext: async () => context,
      })
    )
    await act(async () => {
      jest.advanceTimersByTime(5 * ACCOUNT_SYNC_POLL_MS)
    })
    await flush()
    expect(poll).not.toHaveBeenCalled()
    setVisibility("visible")
    await act(async () => {
      jest.advanceTimersByTime(0)
    })
    await flush()
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it("backs off after a failure and records it", async () => {
    const poll = jest.fn(async (): Promise<PollResult> => Promise.reject(new Error("offline")))
    renderHook(() =>
      useAccountSyncPoller({
        enabled: true,
        notificationText: text,
        poll,
        resolveContext: async () => context,
      })
    )
    await act(async () => {
      jest.advanceTimersByTime(0)
    })
    await flush()
    expect(useAccountSyncStore.getState().error).toEqual({ message: "offline", failures: 1 })
    await act(async () => {
      jest.advanceTimersByTime(ACCOUNT_SYNC_POLL_MS)
    })
    await flush()
    expect(poll).toHaveBeenCalledTimes(1)
    await act(async () => {
      jest.advanceTimersByTime(ACCOUNT_SYNC_POLL_MS)
    })
    await flush()
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it("looks now when an action asks", async () => {
    const poll = jest.fn(async (): Promise<PollResult> => ({
      view: { kind: "signed-out" },
      incoming: [],
    }))
    renderHook(() =>
      useAccountSyncPoller({
        enabled: true,
        notificationText: text,
        poll,
        resolveContext: async () => context,
      })
    )
    await act(async () => {
      jest.advanceTimersByTime(0)
    })
    await flush()
    act(() => useAccountSyncStore.getState().requestRefresh())
    await act(async () => {
      jest.advanceTimersByTime(0)
    })
    await flush()
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it("resolves the official session by default", async () => {
    const poll = jest.fn(async (): Promise<PollResult> => ({
      view: { kind: "signed-out" },
      incoming: [],
    }))
    renderHook(() => useAccountSyncPoller({ enabled: true, notificationText: text, poll }))
    await act(async () => {
      jest.advanceTimersByTime(0)
    })
    await flush()
    expect(officialSyncSession).toHaveBeenCalled()
    expect(poll).toHaveBeenCalledWith(null)
  })
})
