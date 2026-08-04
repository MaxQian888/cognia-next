/** @jest-environment jsdom */
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

  it("scrolls by half a viewport", () => {
    const { result } = renderHook(() => useScroll())
    act(() => result.current.measure(100, 20))
    act(() => result.current.halfPageUp())
    expect(result.current.offset).toBe(70)
    act(() => result.current.halfPageDown())
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

  it("jumps to a target row ~1/3 down the viewport", () => {
    const { result } = renderHook(() => useScroll())
    act(() => result.current.measure(100, 30))
    act(() => result.current.toRow(50))
    // lead = floor(30/3) = 10 ⇒ offset 40, not sticking.
    expect(result.current.offset).toBe(40)
    expect(result.current.atBottom).toBe(false)
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

  it("preserves the top block anchor across width-dependent height corrections", () => {
    const { result } = renderHook(() => useScroll())
    act(() =>
      result.current.setBlockMetrics([
        { id: "a", rows: 3 },
        { id: "b", rows: 5 },
      ])
    )
    act(() => result.current.measure(8, 3))
    act(() => result.current.toRow(4))
    expect(result.current.offset).toBe(3)
    act(() =>
      result.current.setBlockMetrics([
        { id: "a", rows: 8 },
        { id: "b", rows: 5 },
      ])
    )
    // scrollToRow(4) biased to top=3 => anchor b+0; b now starts at row 8.
    expect(result.current.offset).toBe(8)
  })

  it("counts appended rows while scrolled up and clears them at End", () => {
    const { result } = renderHook(() => useScroll())
    act(() => result.current.setBlockMetrics([{ id: "a", rows: 10 }]))
    act(() => result.current.measure(10, 4))
    act(() => result.current.toTop())
    act(() =>
      result.current.setBlockMetrics([
        { id: "a", rows: 10 },
        { id: "b", rows: 7 },
      ])
    )
    expect(result.current.offset).toBe(0)
    expect(result.current.newRowsBelow).toBe(7)
    act(() => result.current.toBottom())
    expect(result.current.newRowsBelow).toBe(0)
  })
})
