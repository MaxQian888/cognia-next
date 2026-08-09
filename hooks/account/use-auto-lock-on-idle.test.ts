/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import { useAutoLockOnIdle } from "./use-auto-lock-on-idle"

let mockIsTauri = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
}))

let mockAutoLockMinutes: number | undefined = 5
let mockSettingsPresent = true
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: mockSettingsPresent ? { accountAutoLockMinutes: mockAutoLockMinutes } : undefined,
    }),
}))

const lockMock = jest.fn()
let mockUnlockedAccountId: string | null = "acct_1"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ unlockedAccountId: mockUnlockedAccountId }),
    { getState: () => ({ lock: lockMock }) }
  ),
}))

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  mockIsTauri = true
  mockAutoLockMinutes = 5
  mockSettingsPresent = true
  mockUnlockedAccountId = "acct_1"
  lockMock.mockResolvedValue(undefined)
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("useAutoLockOnIdle", () => {
  it("locks after the configured idle timeout elapses", () => {
    renderHook(() => useAutoLockOnIdle())

    jest.advanceTimersByTime(5 * 60_000)

    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("contains runtime-clear rejection when the timeout elapses", async () => {
    lockMock.mockRejectedValueOnce(new Error("runtime busy"))
    renderHook(() => useAutoLockOnIdle())

    jest.advanceTimersByTime(5 * 60_000)
    await Promise.resolve()

    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("resets the timer on user activity", () => {
    renderHook(() => useAutoLockOnIdle())

    jest.advanceTimersByTime(4 * 60_000)
    window.dispatchEvent(new Event("keydown"))
    jest.advanceTimersByTime(4 * 60_000)
    expect(lockMock).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1 * 60_000)
    expect(lockMock).toHaveBeenCalledTimes(1)
  })

  it("does not reset while the document is hidden", () => {
    const visibilitySpy = jest.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    renderHook(() => useAutoLockOnIdle())

    jest.advanceTimersByTime(4 * 60_000)
    window.dispatchEvent(new Event("pointerdown")) // ignored while hidden
    jest.advanceTimersByTime(1 * 60_000)

    expect(lockMock).toHaveBeenCalledTimes(1)
    visibilitySpy.mockRestore()
  })

  it("is a no-op when auto-lock is disabled", () => {
    mockAutoLockMinutes = 0
    renderHook(() => useAutoLockOnIdle())

    jest.advanceTimersByTime(60 * 60_000)

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("is a no-op when settings have not hydrated yet", () => {
    mockSettingsPresent = false
    renderHook(() => useAutoLockOnIdle())

    jest.advanceTimersByTime(60 * 60_000)

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("is a no-op when no account is unlocked", () => {
    mockUnlockedAccountId = null
    renderHook(() => useAutoLockOnIdle())

    jest.advanceTimersByTime(60 * 60_000)

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("is a no-op off Tauri", () => {
    mockIsTauri = false
    renderHook(() => useAutoLockOnIdle())

    jest.advanceTimersByTime(60 * 60_000)

    expect(lockMock).not.toHaveBeenCalled()
  })

  it("clears the timer on unmount", () => {
    const { unmount } = renderHook(() => useAutoLockOnIdle())

    jest.advanceTimersByTime(4 * 60_000)
    unmount()
    jest.advanceTimersByTime(10 * 60_000)

    expect(lockMock).not.toHaveBeenCalled()
  })
})
