/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"
import type { RefObject } from "react"

import { BOARD_EDGE_SCROLL_MAX_PX } from "@/lib/issues/board-autoscroll"
import { useBoardEdgeScroll } from "./use-board-edge-scroll"

/** A stand-in for the board's horizontal scroller with controllable geometry. */
function makeScroller({
  left = 100,
  right = 1100,
  scrollLeft = 200,
  scrollWidth = 3000,
  clientWidth = 1000,
} = {}) {
  const element = document.createElement("div")
  element.getBoundingClientRect = () =>
    ({ left, right, width: right - left, top: 0, bottom: 0, height: 0, x: left, y: 0 }) as DOMRect
  Object.defineProperty(element, "scrollWidth", { value: scrollWidth, configurable: true })
  Object.defineProperty(element, "clientWidth", { value: clientWidth, configurable: true })
  element.scrollLeft = scrollLeft
  return element
}

/** Drain N queued animation frames. */
function flushFrames(count = 1) {
  for (let i = 0; i < count; i += 1) {
    act(() => {
      jest.advanceTimersByTime(16)
    })
  }
}

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

describe("useBoardEdgeScroll", () => {
  it("does not scroll a pointer in the middle of the board", () => {
    const element = makeScroller()
    const ref = { current: element } as RefObject<HTMLElement | null>
    const { result } = renderHook(() => useBoardEdgeScroll(ref))
    act(() => result.current.track(600))
    flushFrames(2)
    expect(element.scrollLeft).toBe(200)
  })

  it("scrolls right when the card reaches the right edge", () => {
    const element = makeScroller()
    const ref = { current: element } as RefObject<HTMLElement | null>
    const { result } = renderHook(() => useBoardEdgeScroll(ref))
    act(() => result.current.track(1100))
    flushFrames(1)
    expect(element.scrollLeft).toBe(200 + BOARD_EDGE_SCROLL_MAX_PX)
  })

  it("scrolls left when the card reaches the left edge", () => {
    const element = makeScroller()
    const ref = { current: element } as RefObject<HTMLElement | null>
    const { result } = renderHook(() => useBoardEdgeScroll(ref))
    act(() => result.current.track(100))
    flushFrames(1)
    expect(element.scrollLeft).toBe(200 - BOARD_EDGE_SCROLL_MAX_PX)
  })

  it("keeps scrolling while the card is parked, without further events", () => {
    const element = makeScroller()
    const ref = { current: element } as RefObject<HTMLElement | null>
    const { result } = renderHook(() => useBoardEdgeScroll(ref))
    act(() => result.current.track(1100))
    flushFrames(3)
    expect(element.scrollLeft).toBe(200 + BOARD_EDGE_SCROLL_MAX_PX * 3)
  })

  it("stops at the end of the board instead of writing past it", () => {
    // 5px of travel left: scrollWidth - clientWidth = 1000, and we start at 995.
    const element = makeScroller({ scrollLeft: 995, scrollWidth: 2000, clientWidth: 1000 })
    const ref = { current: element } as RefObject<HTMLElement | null>
    const { result } = renderHook(() => useBoardEdgeScroll(ref))
    act(() => result.current.track(1100))
    flushFrames(3)
    expect(element.scrollLeft).toBe(1000)
  })

  it("stops when told to", () => {
    const element = makeScroller()
    const ref = { current: element } as RefObject<HTMLElement | null>
    const { result } = renderHook(() => useBoardEdgeScroll(ref))
    act(() => result.current.track(1100))
    flushFrames(1)
    const afterOne = element.scrollLeft
    act(() => result.current.stop())
    flushFrames(3)
    expect(element.scrollLeft).toBe(afterOne)
  })

  it("treats a null position as a stop", () => {
    const element = makeScroller()
    const ref = { current: element } as RefObject<HTMLElement | null>
    const { result } = renderHook(() => useBoardEdgeScroll(ref))
    act(() => result.current.track(1100))
    flushFrames(1)
    const afterOne = element.scrollLeft
    act(() => result.current.track(null))
    flushFrames(3)
    expect(element.scrollLeft).toBe(afterOne)
  })

  it("is inert without an element", () => {
    const ref = { current: null } as RefObject<HTMLElement | null>
    const { result } = renderHook(() => useBoardEdgeScroll(ref))
    expect(() => {
      act(() => result.current.track(1100))
      flushFrames(2)
    }).not.toThrow()
  })

  it("cancels its frame on unmount, so a route change cannot scroll a detached node", () => {
    const element = makeScroller()
    const ref = { current: element } as RefObject<HTMLElement | null>
    const { result, unmount } = renderHook(() => useBoardEdgeScroll(ref))
    act(() => result.current.track(1100))
    flushFrames(1)
    const afterOne = element.scrollLeft
    unmount()
    flushFrames(3)
    expect(element.scrollLeft).toBe(afterOne)
  })
})
