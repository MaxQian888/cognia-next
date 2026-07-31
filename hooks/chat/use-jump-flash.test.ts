/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { JUMP_FLASH_BASE_MS, jumpFlashHoldMs, useJumpFlash } from "./use-jump-flash"
import { useSettingsStore } from "@/stores/settings/settings-store"

beforeEach(() => {
  jest.useFakeTimers()
  useSettingsStore.setState({ settings: {} as never })
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("jumpFlashHoldMs", () => {
  it("scales the base hold by the motion duration scale", () => {
    expect(jumpFlashHoldMs(1)).toBe(JUMP_FLASH_BASE_MS)
    // A 2x *duration* scale is the SLOW end of the preference, so it holds
    // longer. Passing the raw speed multiplier here would invert that.
    expect(jumpFlashHoldMs(2)).toBe(JUMP_FLASH_BASE_MS * 2)
  })

  it("floors absurdly small scales so the mark is never instantaneous", () => {
    // The settings slider bottoms out at 0.25; anything lower (or zero) would
    // otherwise clear the mark in the same tick it was set.
    expect(jumpFlashHoldMs(0)).toBe(JUMP_FLASH_BASE_MS * 0.25)
    expect(jumpFlashHoldMs(-3)).toBe(JUMP_FLASH_BASE_MS * 0.25)
  })
})

describe("useJumpFlash", () => {
  it("starts with nothing marked", () => {
    const { result } = renderHook(() => useJumpFlash())
    expect(result.current.flashId).toBeNull()
  })

  it("marks the jumped-to message and clears it after the hold", () => {
    const { result } = renderHook(() => useJumpFlash())

    act(() => result.current.flash("m1"))
    expect(result.current.flashId).toBe("m1")

    act(() => jest.advanceTimersByTime(JUMP_FLASH_BASE_MS - 1))
    expect(result.current.flashId).toBe("m1")

    act(() => jest.advanceTimersByTime(1))
    expect(result.current.flashId).toBeNull()
  })

  it("bumps the nonce so re-jumping the same message re-marks it", () => {
    // Without this the second jump changes no state, React does not re-render,
    // and the user — who repeated the action precisely because they were unsure
    // it worked — sees nothing at all.
    const { result } = renderHook(() => useJumpFlash())

    act(() => result.current.flash("m1"))
    const first = result.current.flashNonce

    act(() => result.current.flash("m1"))
    expect(result.current.flashId).toBe("m1")
    expect(result.current.flashNonce).toBe(first + 1)
  })

  it("re-jumping restarts the hold rather than inheriting the old deadline", () => {
    const { result } = renderHook(() => useJumpFlash())

    act(() => result.current.flash("m1"))
    act(() => jest.advanceTimersByTime(JUMP_FLASH_BASE_MS - 100))
    act(() => result.current.flash("m1"))

    act(() => jest.advanceTimersByTime(200))
    expect(result.current.flashId).toBe("m1")
  })

  it("a stale timer cannot blank a newer flash", () => {
    const { result } = renderHook(() => useJumpFlash())

    act(() => result.current.flash("m1"))
    act(() => jest.advanceTimersByTime(JUMP_FLASH_BASE_MS - 50))
    act(() => result.current.flash("m2"))

    // The first message's deadline passes here; the mark on m2 must survive.
    act(() => jest.advanceTimersByTime(100))
    expect(result.current.flashId).toBe("m2")
  })

  it("shortens the hold when the motion-speed preference is faster", () => {
    // 2x speed is a 0.5x duration scale, so the mark holds for half as long.
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 2 } } as never })
    const { result } = renderHook(() => useJumpFlash())
    expect(result.current.holdMs).toBe(JUMP_FLASH_BASE_MS * 0.5)

    act(() => result.current.flash("m1"))
    act(() => jest.advanceTimersByTime(JUMP_FLASH_BASE_MS * 0.25))
    expect(result.current.flashId).toBe("m1")

    act(() => jest.advanceTimersByTime(JUMP_FLASH_BASE_MS * 0.25))
    expect(result.current.flashId).toBeNull()
  })

  it("lengthens the hold when the motion-speed preference is slower", () => {
    // 0.5x speed is a 2x duration scale — the reciprocal of the case above.
    useSettingsStore.setState({ settings: { motion: { reduce: false, speed: 0.5 } } as never })
    const { result } = renderHook(() => useJumpFlash())
    expect(result.current.holdMs).toBe(JUMP_FLASH_BASE_MS * 2)
  })

  it("drops its pending timer on unmount", () => {
    const { result, unmount } = renderHook(() => useJumpFlash())
    act(() => result.current.flash("m1"))
    unmount()
    // A surviving timer would call setState on an unmounted hook.
    expect(jest.getTimerCount()).toBe(0)
  })
})
