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

  it("starts observing an element that attaches after the first commit", () => {
    // `if (!mounted) return null` components hand the hook a `null` ref on
    // their first commit and only attach the element on the next render.
    const { el, geometry } = setup(312)
    const { result, rerender } = renderHook(
      ({ attached }: { attached: boolean }) => {
        const ref = useRef<HTMLElement | null>(null)
        ref.current = attached ? el : null
        return useElementWidth(ref)
      },
      { initialProps: { attached: false } }
    )
    expect(result.current).toBe(0)
    expect(MockResizeObserver.instances).toHaveLength(0)

    rerender({ attached: true })
    expect(result.current).toBe(312)
    expect(MockResizeObserver.instances).toHaveLength(1)
    expect(MockResizeObserver.instances[0]?.observed).toEqual([el])

    act(() => {
      geometry.width = 200
      MockResizeObserver.instances[0]?.trigger()
    })
    expect(result.current).toBe(200)
  })

  it("keeps one observer across re-renders and rebinds only when the element changes", () => {
    const a = setup(100)
    const b = setup(180)
    const { result, rerender } = renderHook(
      ({ target }: { target: HTMLElement }) => {
        const ref = useRef<HTMLElement | null>(null)
        ref.current = target
        return useElementWidth(ref)
      },
      { initialProps: { target: a.el } }
    )
    expect(result.current).toBe(100)
    rerender({ target: a.el })
    rerender({ target: a.el })
    expect(MockResizeObserver.instances).toHaveLength(1)

    rerender({ target: b.el })
    expect(result.current).toBe(180)
    expect(MockResizeObserver.instances).toHaveLength(2)
    // The first observer was released when the element changed.
    expect(MockResizeObserver.instances[0]?.observed).toEqual([])
    expect(MockResizeObserver.instances[1]?.observed).toEqual([b.el])
  })

  it("drops back to 0 and releases the observer when the element detaches", () => {
    const { el } = setup(240)
    const { result, rerender, unmount } = renderHook(
      ({ attached }: { attached: boolean }) => {
        const ref = useRef<HTMLElement | null>(null)
        ref.current = attached ? el : null
        return useElementWidth(ref)
      },
      { initialProps: { attached: true } }
    )
    expect(result.current).toBe(240)
    rerender({ attached: false })
    expect(result.current).toBe(0)
    expect(MockResizeObserver.instances[0]?.observed).toEqual([])

    rerender({ attached: true })
    expect(result.current).toBe(240)
    unmount()
    expect(MockResizeObserver.instances.at(-1)?.observed).toEqual([])
  })
})
