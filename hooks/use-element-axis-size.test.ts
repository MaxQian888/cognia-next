/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import { useElementAxisSize } from "./use-element-axis-size"

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

function setup(width: number, height: number) {
  const geometry = { width, height }
  const el = document.createElement("div")
  el.getBoundingClientRect = () => ({ width: geometry.width, height: geometry.height }) as DOMRect
  document.body.appendChild(el)
  return { el, geometry }
}

describe("useElementAxisSize", () => {
  it("returns 0 when no element is provided", () => {
    const { result } = renderHook(() => useElementAxisSize(null, "width"))
    expect(result.current).toBe(0)
  })

  it("measures the requested axis synchronously on mount", () => {
    const { el } = setup(320, 96)
    expect(renderHook(() => useElementAxisSize(el, "width")).result.current).toBe(320)
    expect(renderHook(() => useElementAxisSize(el, "height")).result.current).toBe(96)
  })

  it("recomputes when ResizeObserver fires", () => {
    const { el, geometry } = setup(320, 80)
    const { result } = renderHook(() => useElementAxisSize(el, "height"))
    expect(result.current).toBe(80)
    act(() => {
      geometry.height = 140
      MockResizeObserver.instances.at(-1)?.trigger()
    })
    expect(result.current).toBe(140)
  })

  it("stays still when only the other axis changes", () => {
    // The terminal dock sizes itself from one axis and resizes along the other;
    // re-rendering the shell for the axis it does not read would be pure cost.
    const { el, geometry } = setup(320, 80)
    const { result, rerender } = renderHook(() => useElementAxisSize(el, "height"))
    act(() => {
      geometry.width = 900
      MockResizeObserver.instances.at(-1)?.trigger()
    })
    rerender()
    expect(result.current).toBe(80)
  })

  it("ignores sub-pixel changes below the 0.5px threshold", () => {
    const { el, geometry } = setup(120, 120)
    const { result } = renderHook(() => useElementAxisSize(el, "width"))
    expect(result.current).toBe(120)
    act(() => {
      geometry.width = 120.2
      MockResizeObserver.instances.at(-1)?.trigger()
    })
    expect(result.current).toBe(120)
  })

  it("re-measures when the axis switches", () => {
    const { el } = setup(320, 80)
    const { result, rerender } = renderHook(
      ({ axis }: { axis: "width" | "height" }) => useElementAxisSize(el, axis),
      { initialProps: { axis: "width" as "width" | "height" } }
    )
    expect(result.current).toBe(320)
    rerender({ axis: "height" })
    expect(result.current).toBe(80)
  })

  it("drops back to 0 when the element goes away", () => {
    const { el } = setup(320, 80)
    const { result, rerender } = renderHook(
      ({ node }: { node: HTMLElement | null }) => useElementAxisSize(node, "width"),
      { initialProps: { node: el as HTMLElement | null } }
    )
    expect(result.current).toBe(320)
    rerender({ node: null })
    expect(result.current).toBe(0)
  })

  it("falls back to window resize when ResizeObserver is unavailable", () => {
    ;(globalThis as unknown as { ResizeObserver: undefined }).ResizeObserver = undefined
    const { el, geometry } = setup(60, 60)
    const { result } = renderHook(() => useElementAxisSize(el, "width"))
    expect(result.current).toBe(60)
    act(() => {
      geometry.width = 200
      window.dispatchEvent(new Event("resize"))
    })
    expect(result.current).toBe(200)
  })
})
