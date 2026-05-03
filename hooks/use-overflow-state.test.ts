/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import { useRef } from "react"
import { useOverflowState } from "./use-overflow-state"

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  private cb: ResizeObserverCallback
  observed: Element[] = []
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    MockResizeObserver.instances.push(this)
  }
  observe(target: Element) {
    this.observed.push(target)
  }
  unobserve(target: Element) {
    this.observed = this.observed.filter((t) => t !== target)
  }
  disconnect() {
    this.observed = []
  }
  trigger() {
    this.cb([], this as unknown as ResizeObserver)
  }
}

beforeEach(() => {
  MockResizeObserver.instances = []
  ;(globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
    MockResizeObserver
})

function setup(geometry: { scrollLeft: number; clientWidth: number; scrollWidth: number }) {
  const el = document.createElement("div")
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    get: () => geometry.scrollLeft,
    set: (value: number) => {
      geometry.scrollLeft = value
    },
  })
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    get: () => geometry.clientWidth,
  })
  Object.defineProperty(el, "scrollWidth", {
    configurable: true,
    get: () => geometry.scrollWidth,
  })
  document.body.appendChild(el)
  return el
}

describe("useOverflowState", () => {
  it("returns false flags when no overflow is present", () => {
    const el = setup({ scrollLeft: 0, clientWidth: 100, scrollWidth: 100 })
    const { result } = renderHook(() => {
      const ref = useRef(el)
      return useOverflowState(ref)
    })
    expect(result.current.hasOverflowLeft).toBe(false)
    expect(result.current.hasOverflowRight).toBe(false)
  })

  it("flags right overflow when content is wider than the viewport", () => {
    const el = setup({ scrollLeft: 0, clientWidth: 100, scrollWidth: 300 })
    const { result } = renderHook(() => {
      const ref = useRef(el)
      return useOverflowState(ref)
    })
    expect(result.current.hasOverflowRight).toBe(true)
    expect(result.current.hasOverflowLeft).toBe(false)
  })

  it("flags left and right when scrolled to a middle position", () => {
    const geometry = { scrollLeft: 50, clientWidth: 100, scrollWidth: 300 }
    const el = setup(geometry)
    const { result } = renderHook(() => {
      const ref = useRef(el)
      return useOverflowState(ref)
    })
    expect(result.current.hasOverflowLeft).toBe(true)
    expect(result.current.hasOverflowRight).toBe(true)
  })

  it("recomputes when ResizeObserver fires", () => {
    const geometry = { scrollLeft: 0, clientWidth: 100, scrollWidth: 100 }
    const el = setup(geometry)
    const { result } = renderHook(() => {
      const ref = useRef(el)
      return useOverflowState(ref)
    })
    expect(result.current.hasOverflowRight).toBe(false)
    act(() => {
      geometry.scrollWidth = 400
      MockResizeObserver.instances.at(-1)?.trigger()
    })
    expect(result.current.hasOverflowRight).toBe(true)
  })

  it("returns idle defaults when ref has no element", () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(null)
      return useOverflowState(ref)
    })
    expect(result.current).toEqual({
      hasOverflowLeft: false,
      hasOverflowRight: false,
    })
  })
})
