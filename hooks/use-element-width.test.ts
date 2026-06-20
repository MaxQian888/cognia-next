/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import { useRef } from "react"
import { useElementWidth } from "./use-element-width"

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

describe("useElementWidth", () => {
  it("returns 0 when the ref has no element", () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(null)
      return useElementWidth(ref)
    })
    expect(result.current).toBe(0)
  })

  it("measures the element width synchronously on mount", () => {
    const { el } = setup(288)
    const { result } = renderHook(() => {
      const ref = useRef(el)
      return useElementWidth(ref)
    })
    expect(result.current).toBe(288)
  })

  it("recomputes when ResizeObserver fires", () => {
    const { el, geometry } = setup(216)
    const { result } = renderHook(() => {
      const ref = useRef(el)
      return useElementWidth(ref)
    })
    expect(result.current).toBe(216)
    act(() => {
      geometry.width = 480
      MockResizeObserver.instances.at(-1)?.trigger()
    })
    expect(result.current).toBe(480)
  })

  it("ignores sub-pixel changes below the 0.5px threshold", () => {
    const { el, geometry } = setup(300)
    const { result } = renderHook(() => {
      const ref = useRef(el)
      return useElementWidth(ref)
    })
    expect(result.current).toBe(300)
    act(() => {
      geometry.width = 300.2
      MockResizeObserver.instances.at(-1)?.trigger()
    })
    expect(result.current).toBe(300)
  })

  it("falls back to window resize when ResizeObserver is unavailable", () => {
    ;(globalThis as unknown as { ResizeObserver: undefined }).ResizeObserver = undefined
    const { el, geometry } = setup(250)
    const { result } = renderHook(() => {
      const ref = useRef(el)
      return useElementWidth(ref)
    })
    expect(result.current).toBe(250)
    act(() => {
      geometry.width = 400
      window.dispatchEvent(new Event("resize"))
    })
    expect(result.current).toBe(400)
  })
})
