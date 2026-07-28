/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import { useDismissableNoticeSet } from "./use-dismissable-notice-set"
import { DISMISS_TTL_MS } from "@/lib/inbox/notice-dismiss"

const KEY = "test.notice.dismiss"

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe("useDismissableNoticeSet", () => {
  it("starts visible when nothing has been dismissed", () => {
    const { result } = renderHook(() => useDismissableNoticeSet(KEY, "local", ["a"]))
    expect(result.current.hidden).toBe(false)
  })

  it("hides the current set once dismissed and persists the snapshot", () => {
    const { result } = renderHook(() => useDismissableNoticeSet(KEY, "local", ["a"]))
    act(() => result.current.dismiss())
    expect(result.current.hidden).toBe(true)
    expect(window.localStorage.getItem(KEY)).toContain('"hash":"a"')
  })

  it("hashes the set order-independently, so row order cannot resurrect it", () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useDismissableNoticeSet(KEY, "local", ids),
      { initialProps: { ids: ["a", "b"] } }
    )
    act(() => result.current.dismiss())
    rerender({ ids: ["b", "a"] })
    expect(result.current.hidden).toBe(true)
  })

  // The dismissal is per-set, not permanent: a different failure deserves a
  // fresh notice.
  it("reappears and clears the snapshot when the set changes", () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useDismissableNoticeSet(KEY, "local", ids),
      { initialProps: { ids: ["a"] } }
    )
    act(() => result.current.dismiss())
    expect(result.current.hidden).toBe(true)

    rerender({ ids: ["a", "b"] })
    expect(result.current.hidden).toBe(false)
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it("starts hidden when a matching dismissal survives a reload", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ hash: "a", at: Date.now() }))
    const { result } = renderHook(() => useDismissableNoticeSet(KEY, "local", ["a"]))
    expect(result.current.hidden).toBe(true)
  })

  it("ignores a stored snapshot that does not parse", () => {
    window.localStorage.setItem(KEY, "not json")
    const { result } = renderHook(() => useDismissableNoticeSet(KEY, "local", ["a"]))
    expect(result.current.hidden).toBe(false)
  })

  it("lets the notice back once the TTL expires, and clears the snapshot", () => {
    jest.useFakeTimers()
    try {
      const { result } = renderHook(() => useDismissableNoticeSet(KEY, "local", ["a"]))
      act(() => result.current.dismiss())
      expect(result.current.hidden).toBe(true)

      act(() => {
        jest.advanceTimersByTime(DISMISS_TTL_MS + 1)
      })

      expect(result.current.hidden).toBe(false)
      expect(window.localStorage.getItem(KEY)).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  // The one thing that differs between the two callers. `sessionStorage` was
  // also the copy that used to leak its snapshot on reset — unifying the
  // machine is what fixed that.
  it("honours the session storage kind on write, read and reset", () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useDismissableNoticeSet(KEY, "session", ids),
      { initialProps: { ids: ["a"] } }
    )
    act(() => result.current.dismiss())
    expect(window.sessionStorage.getItem(KEY)).toContain('"hash":"a"')
    expect(window.localStorage.getItem(KEY)).toBeNull()

    rerender({ ids: ["b"] })
    expect(result.current.hidden).toBe(false)
    expect(window.sessionStorage.getItem(KEY)).toBeNull()
  })

  it("treats an empty set as its own hash rather than crashing", () => {
    const { result } = renderHook(() => useDismissableNoticeSet(KEY, "local", []))
    expect(result.current.hidden).toBe(false)
    act(() => result.current.dismiss())
    expect(result.current.hidden).toBe(true)
  })

  it("survives a storage that refuses writes", () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    try {
      const { result } = renderHook(() => useDismissableNoticeSet(KEY, "local", ["a"]))
      act(() => result.current.dismiss())
      // The write failed, but the in-memory dismissal still takes effect.
      expect(result.current.hidden).toBe(true)
    } finally {
      setItem.mockRestore()
    }
  })
})
