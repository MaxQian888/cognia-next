/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import { JUMP_RETURN_TTL_MS, useJumpHistory } from "./use-jump-history"

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("useJumpHistory", () => {
  it("offers nothing until a jump has happened", () => {
    const { result } = renderHook(() => useJumpHistory("s1"))
    expect(result.current.canReturn).toBe(false)
    expect(result.current.takeReturn()).toBeNull()
  })

  it("offers the remembered offset back and then withdraws the offer", () => {
    const { result } = renderHook(() => useJumpHistory("s1"))

    act(() => result.current.remember(1234))
    expect(result.current.canReturn).toBe(true)

    let offset: number | null = null
    act(() => {
      offset = result.current.takeReturn()
    })
    expect(offset).toBe(1234)
    // Single-use: the user has gone back, so there is nothing to go back to.
    expect(result.current.canReturn).toBe(false)
    expect(result.current.takeReturn()).toBeNull()
  })

  it("remembers offset zero rather than treating it as nothing", () => {
    // Jumping away from the very top is the ordinary case for a long history,
    // and 0 is falsy — the exact value a naive truthiness check would drop.
    const { result } = renderHook(() => useJumpHistory("s1"))
    act(() => result.current.remember(0))
    expect(result.current.canReturn).toBe(true)

    let offset: number | null = -1
    act(() => {
      offset = result.current.takeReturn()
    })
    expect(offset).toBe(0)
  })

  it("expires the offer, because a stale one promises a place nobody wants", () => {
    const { result } = renderHook(() => useJumpHistory("s1"))
    act(() => result.current.remember(500))

    act(() => jest.advanceTimersByTime(JUMP_RETURN_TTL_MS - 1))
    expect(result.current.canReturn).toBe(true)

    act(() => jest.advanceTimersByTime(1))
    expect(result.current.canReturn).toBe(false)
    expect(result.current.takeReturn()).toBeNull()
  })

  it("a second jump replaces the offer and restarts its clock", () => {
    const { result } = renderHook(() => useJumpHistory("s1"))
    act(() => result.current.remember(100))
    act(() => jest.advanceTimersByTime(JUMP_RETURN_TTL_MS - 100))
    act(() => result.current.remember(900))

    act(() => jest.advanceTimersByTime(200))
    expect(result.current.canReturn).toBe(true)

    let offset: number | null = null
    act(() => {
      offset = result.current.takeReturn()
    })
    expect(offset).toBe(900)
  })

  it("forget withdraws the offer — the user chose somewhere else", () => {
    const { result } = renderHook(() => useJumpHistory("s1"))
    act(() => result.current.remember(500))
    act(() => result.current.forget())
    expect(result.current.canReturn).toBe(false)
    expect(result.current.takeReturn()).toBeNull()
  })

  it("drops the offer when the conversation changes", () => {
    // A scroll offset means nothing in another conversation; honouring it would
    // dump the user at an arbitrary point in a thread they just opened.
    const { result, rerender } = renderHook(({ id }) => useJumpHistory(id), {
      initialProps: { id: "s1" },
    })
    act(() => result.current.remember(700))
    expect(result.current.canReturn).toBe(true)

    rerender({ id: "s2" })
    expect(result.current.canReturn).toBe(false)
    expect(result.current.takeReturn()).toBeNull()
  })

  it("drops its pending timer on unmount", () => {
    const { result, unmount } = renderHook(() => useJumpHistory("s1"))
    act(() => result.current.remember(500))
    unmount()
    expect(jest.getTimerCount()).toBe(0)
  })
})
