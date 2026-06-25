/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import { useElementHeight } from "./use-element-height"

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

function setup(height: number) {
  const geometry = { height }
  const el = document.createElement("div")
  el.getBoundingClientRect = () => ({ width: 0, height: geometry.height }) as DOMRect
  document.body.appendChild(el)
  return { el, geometry }
}

describe("useElementHeight", () => {
  it("returns 0 when no element is provided", () => {
    const { result } = renderHook(() => useElementHeight(null))
    expect(result.current).toBe(0)
  })

  it("measures the element height synchronously on mount", () => {
    const { el } = setup(96)
    const { result } = renderHook(() => useElementHeight(el))
    expect(result.current).toBe(96)
  })

  it("recomputes when ResizeObserver fires", () => {
    const { el, geometry } = setup(80)
    const { result } = renderHook(() => useElementHeight(el))
    expect(result.current).toBe(80)
    act(() => {
      geometry.height = 140
      MockResizeObserver.instances.at(-1)?.trigger()
    })
    expect(result.current).toBe(140)
  })

  it("ignores sub-pixel changes below the 0.5px threshold", () => {
    const { el, geometry } = setup(120)
    const { result } = renderHook(() => useElementHeight(el))
    expect(result.current).toBe(120)
    act(() => {
      geometry.height = 120.2
      MockResizeObserver.instances.at(-1)?.trigger()
    })
    expect(result.current).toBe(120)
  })

  it("falls back to window resize when ResizeObserver is unavailable", () => {
    ;(globalThis as unknown as { ResizeObserver: undefined }).ResizeObserver = undefined
    const { el, geometry } = setup(60)
    const { result } = renderHook(() => useElementHeight(el))
    expect(result.current).toBe(60)
    act(() => {
      geometry.height = 200
      window.dispatchEvent(new Event("resize"))
    })
    expect(result.current).toBe(200)
  })
})
