import { act, renderHook } from "@testing-library/react"

import { useScroll } from "./useScroll"

describe("useScroll", () => {
  it("starts pinned to the bottom with no measured content", () => {
    const { result } = renderHook(() => useScroll())
    expect(result.current.offset).toBe(0)
    expect(result.current.atBottom).toBe(true)
    expect(result.current.hidden).toEqual({ above: 0, below: 0 })
  })

  it("pins to the bottom once content is measured", () => {
    const { result } = renderHook(() => useScroll())
    act(() => result.current.measure(50, 20))
    // stick=true ⇒ offset = maxScroll = 30
    expect(result.current.offset).toBe(30)
    expect(result.current.atBottom).toBe(true)
    expect(result.current.hidden).toEqual({ above: 30, below: 0 })
  })

  it("pages up off the bottom and reports rows below", () => {
    const { result } = renderHook(() => useScroll())
    act(() => result.current.measure(50, 20))
    act(() => result.current.pageUp())
    // step = viewport-1 = 19, from 30 → 11
    expect(result.current.offset).toBe(11)
    expect(result.current.atBottom).toBe(false)
    expect(result.current.hidden).toEqual({ above: 11, below: 19 })
  })

  it("pages down and re-pins to the bottom", () => {
    const { result } = renderHook(() => useScroll())
    act(() => result.current.measure(50, 20))
    act(() => result.current.pageUp())
    act(() => result.current.pageDown())
    expect(result.current.atBottom).toBe(true)
    expect(result.current.offset).toBe(30)
  })

  it("scrolls a single line up and down", () => {
    const { result } = renderHook(() => useScroll())
    act(() => result.current.measure(50, 20))
    act(() => result.current.lineUp())
    expect(result.current.offset).toBe(29)
    act(() => result.current.lineDown())
    expect(result.current.atBottom).toBe(true)
  })

  it("jumps to the top and back to the bottom", () => {
    const { result } = renderHook(() => useScroll())
    act(() => result.current.measure(50, 20))
    act(() => result.current.toTop())
    expect(result.current.offset).toBe(0)
    expect(result.current.atBottom).toBe(false)
    act(() => result.current.toBottom())
    expect(result.current.atBottom).toBe(true)
  })

  it("reset re-pins to the bottom", () => {
    const { result } = renderHook(() => useScroll())
    act(() => result.current.measure(50, 20))
    act(() => result.current.toTop())
    act(() => result.current.reset())
    expect(result.current.atBottom).toBe(true)
  })

  it("ignores a measure that doesn't change the sizes (stable identity)", () => {
    const { result } = renderHook(() => useScroll())
    act(() => result.current.measure(50, 20))
    const before = result.current.measure
    act(() => result.current.measure(50, 20))
    // measure is a stable useCallback; a no-op call doesn't churn state.
    expect(result.current.measure).toBe(before)
    expect(result.current.offset).toBe(30)
  })

  it("keeps a scrolled-up position accurate after the content grows", () => {
    const { result } = renderHook(() => useScroll())
    act(() => result.current.measure(50, 20))
    act(() => result.current.toTop()) // top, not sticking
    act(() => result.current.measure(80, 20)) // content grew
    // Still pinned to the top (offset 0) since we're not sticking.
    expect(result.current.offset).toBe(0)
    expect(result.current.hidden.below).toBe(60)
  })
})
