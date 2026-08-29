/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { useAutoLockOnIdle } from "./use-auto-lock-on-idle"

let mockPetRole: string | null = null
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockPetRole,
  isSecondaryOverlayRole: (role: string | null) => role === "overlay" || role === "popup",
}))

let mockAutoLockMinutes: number | undefined = 5
let mockSettingsPresent = true
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: mockSettingsPresent ? { accountAutoLockMinutes: mockAutoLockMinutes } : undefined,
    }),
}))

let mockSessions: Record<string, { status: string }> = {}
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ sessions: mockSessions }),
    { getState: () => ({ sessions: mockSessions }) }
  ),
}))

const interruptSessionMock = jest.fn<Promise<void>, [string]>()
jest.mock("@/lib/claude/ipc", () => ({
  interruptSession: (sessionId: string) => interruptSessionMock(sessionId),
}))

const lockMock = jest.fn()
let mockUnlockedAccountId: string | null = "acct_1"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ unlockedAccountId: mockUnlockedAccountId }),
    { getState: () => ({ lock: lockMock }) }
  ),
}))

const FIVE_MINUTES = 5 * 60_000

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"))
  jest.clearAllMocks()
  mockPetRole = null
  mockAutoLockMinutes = 5
  mockSettingsPresent = true
  mockUnlockedAccountId = "acct_1"
  mockSessions = {}
  lockMock.mockResolvedValue(undefined)
  interruptSessionMock.mockResolvedValue()
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("useAutoLockOnIdle", () => {
  it("locks after the configured idle timeout elapses", () => {
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })

    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("does not lock before the timeout", () => {
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES - 1_000)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("waits out the remainder when activity lands before the deadline", () => {
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES - 10_000)
      window.dispatchEvent(new Event("keydown"))
      jest.advanceTimersByTime(10_001)
    })
    expect(lockMock).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("locks on the next focus when a throttled tab never fired its timer", () => {
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      // Wall-clock moves past the deadline without the timer being delivered,
      // which is exactly what a backgrounded tab does.
      jest.setSystemTime(Date.now() + FIVE_MINUTES + 1_000)
      window.dispatchEvent(new Event("focus"))
    })

    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("is inert when auto-lock is off", () => {
    mockAutoLockMinutes = 0
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 4)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("is inert before settings have hydrated", () => {
    mockSettingsPresent = false
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 4)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("is inert when no account is unlocked", () => {
    mockUnlockedAccountId = null
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 4)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("defers a streaming turn for at most one extra lock cycle, then interrupts and locks", async () => {
    mockSessions = { s1: { status: "streaming" } }
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })
    expect(lockMock).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })
    await act(async () => Promise.resolve())

    expect(interruptSessionMock).toHaveBeenCalledWith("s1")
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("defers an approval for at most one extra lock cycle, then interrupts and locks", async () => {
    mockSessions = { s1: { status: "awaiting_approval" } }
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 2)
    })
    await act(async () => Promise.resolve())

    expect(interruptSessionMock).toHaveBeenCalledWith("s1")
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("does not run on an overlay window, which cannot see the main window's activity", () => {
    mockPetRole = "overlay"
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 4)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("runs in an ordinary browser — a Browser Vault account is a real lock", () => {
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })

    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("clears its timer and listeners on unmount", () => {
    const { unmount } = renderHook(() => useAutoLockOnIdle())
    unmount()

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES * 4)
    })

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("swallows a rejected lock rather than surfacing an unhandled rejection", async () => {
    lockMock.mockRejectedValueOnce(new Error("teardown failed"))
    renderHook(() => useAutoLockOnIdle())

    act(() => {
      jest.advanceTimersByTime(FIVE_MINUTES)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(lockMock).toHaveBeenCalledTimes(1)
  })
})
