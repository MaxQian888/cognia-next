/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const lockMock = jest.fn()
const state = { minutes: 0, locked: false, streaming: false }

jest.mock("@/stores/account/account-store", () => {
  const useAccountStore = (selector: (s: { locked: boolean }) => unknown) =>
    selector({ locked: state.locked })
  useAccountStore.getState = () => ({ lock: lockMock })
  return { useAccountStore }
})

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { settings: { accountAutoLockMinutes: number } }) => unknown) =>
    selector({ settings: { accountAutoLockMinutes: state.minutes } }),
}))

jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: { sessions: Record<string, { status: string }> }) => unknown) =>
    selector({
      sessions: state.streaming ? { local: { status: "streaming" } } : {},
    }),
}))

import { useAutoLock } from "./use-auto-lock"

const MIN = 60_000

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => value,
  })
}

beforeEach(() => {
  lockMock.mockReset()
  state.minutes = 0
  state.locked = false
  state.streaming = false
  jest.useFakeTimers()
  jest.setSystemTime(0)
  setVisibility("visible")
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("useAutoLock", () => {
  it("never locks when the timeout is off (0)", () => {
    state.minutes = 0
    renderHook(() => useAutoLock())
    act(() => {
      jest.advanceTimersByTime(10 * MIN)
    })
    expect(lockMock).not.toHaveBeenCalled()
  })

  it("does not arm when already locked", () => {
    state.minutes = 1
    state.locked = true
    renderHook(() => useAutoLock())
    act(() => {
      jest.advanceTimersByTime(5 * MIN)
    })
    expect(lockMock).not.toHaveBeenCalled()
  })

  it("pauses auto-lock while a local turn is streaming", () => {
    state.minutes = 1
    state.streaming = true
    renderHook(() => useAutoLock())
    act(() => {
      jest.advanceTimersByTime(5 * MIN)
    })
    expect(lockMock).not.toHaveBeenCalled()
  })

  it("locks after the idle window elapses", () => {
    state.minutes = 1
    renderHook(() => useAutoLock())
    act(() => {
      jest.advanceTimersByTime(MIN)
    })
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("resets the countdown on user activity", () => {
    state.minutes = 1
    renderHook(() => useAutoLock())
    act(() => {
      jest.advanceTimersByTime(50_000)
      window.dispatchEvent(new Event("keydown"))
      jest.advanceTimersByTime(50_000) // t=100s: original timer fired at 60s, re-armed to 110s
    })
    expect(lockMock).not.toHaveBeenCalled()
    act(() => {
      jest.advanceTimersByTime(15_000) // t=115s > 110s deadline
    })
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("locks immediately on visibility regain when the window already elapsed while backgrounded", () => {
    state.minutes = 1
    renderHook(() => useAutoLock())
    // Jump the wall clock past the deadline WITHOUT firing the throttled timer.
    act(() => {
      jest.setSystemTime(70_000)
      setVisibility("visible")
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("ignores a visibilitychange to hidden", () => {
    state.minutes = 1
    renderHook(() => useAutoLock())
    act(() => {
      jest.setSystemTime(70_000)
      setVisibility("hidden")
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(lockMock).not.toHaveBeenCalled()
  })
})
