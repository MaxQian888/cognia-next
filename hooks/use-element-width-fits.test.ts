/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import { useRef } from "react"

import { useElementWidthFits } from "./use-element-width-fits"

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

function setup(width: number) {
  const geometry = { width }
  const el = document.createElement("div")
  el.getBoundingClientRect = () => ({ width: geometry.width, height: 0 }) as DOMRect
  document.body.appendChild(el)
  return { el, geometry }
}

describe("useElementWidthFits", () => {
  it("reads an unattached ref as fitting", () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(null)
      return useElementWidthFits(ref, 400)
    })
    expect(result.current).toBe(true)
  })

  it("reads a 0-wide (unmeasured) element as fitting", () => {
    const { el } = setup(0)
    const { result } = renderHook(() => useElementWidthFits(useRef(el), 400))
    expect(result.current).toBe(true)
  })

  it("measures against the threshold on mount", () => {
    const { el } = setup(320)
    const { result } = renderHook(() => useElementWidthFits(useRef(el), 400))
    expect(result.current).toBe(false)
  })

  it("re-renders only when a resize crosses the threshold", () => {
    const { el, geometry } = setup(500)
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useElementWidthFits(useRef(el), 400)
    })
    const settled = renders
    const observer = MockResizeObserver.instances[0]

    // A drag that stays above the threshold changes nothing React can see.
    for (const width of [520, 610, 480, 401]) {
      geometry.width = width
      act(() => observer.trigger())
    }
    expect(renders).toBe(settled)
    expect(result.current).toBe(true)

    geometry.width = 399
    act(() => observer.trigger())
    expect(result.current).toBe(false)
    expect(renders).toBeGreaterThan(settled)
  })

  it("re-evaluates when the threshold itself changes", () => {
    const { el } = setup(450)
    const { result, rerender } = renderHook(({ min }) => useElementWidthFits(useRef(el), min), {
      initialProps: { min: 400 },
    })
    expect(result.current).toBe(true)
    rerender({ min: 500 })
    expect(result.current).toBe(false)
  })

  it("disconnects its observer on unmount", () => {
    const { el } = setup(500)
    const { unmount } = renderHook(() => useElementWidthFits(useRef(el), 400))
    const observer = MockResizeObserver.instances[0]
    expect(observer.observed).toEqual([el])
    unmount()
    expect(observer.observed).toEqual([])
  })
})
