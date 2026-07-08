/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { useRegionVisibility } from "./use-region-visibility"

// jsdom has no IntersectionObserver — stub one that exposes its callback.
let ioCallback: ((entries: unknown[]) => void) | null = null
const ioObserve = jest.fn()
const ioDisconnect = jest.fn()

class MockIO {
  constructor(cb: (entries: unknown[]) => void) {
    ioCallback = cb
  }
  observe = ioObserve
  disconnect = ioDisconnect
  unobserve = jest.fn()
  takeRecords = jest.fn()
}

beforeEach(() => {
  ioCallback = null
  ioObserve.mockClear()
  ioDisconnect.mockClear()
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO
  document.body.innerHTML = ""
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
})

/** Attach an element under `document.body` and return a stable ref to it. */
function mountRegion() {
  const wrap = document.createElement("div")
  const el = document.createElement("div")
  wrap.appendChild(el)
  document.body.appendChild(wrap)
  const ref = { current: el } as React.RefObject<HTMLElement>
  const view = renderHook(() => useRegionVisibility(ref))
  return { ...view, el, wrap }
}

it("is visible by default", () => {
  const { result } = mountRegion()
  expect(result.current).toBe(true)
  expect(ioObserve).toHaveBeenCalled()
})

it("hides when a modal marks an ancestor aria-hidden, and restores on close", async () => {
  const { result, wrap } = mountRegion()
  expect(result.current).toBe(true)

  await act(async () => {
    wrap.setAttribute("aria-hidden", "true")
  })
  expect(result.current).toBe(false)

  await act(async () => {
    wrap.removeAttribute("aria-hidden")
  })
  expect(result.current).toBe(true)
})

it("hides when an ancestor becomes inert", async () => {
  const { result, wrap } = mountRegion()
  await act(async () => {
    wrap.setAttribute("inert", "")
  })
  expect(result.current).toBe(false)
})

it("hides when the window is backgrounded", () => {
  const { result } = mountRegion()
  act(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  expect(result.current).toBe(false)
})

it("hides when the region scrolls off screen", () => {
  const { result } = mountRegion()
  act(() => ioCallback?.([{ isIntersecting: false, intersectionRatio: 0 }]))
  expect(result.current).toBe(false)
  act(() => ioCallback?.([{ isIntersecting: true, intersectionRatio: 1 }]))
  expect(result.current).toBe(true)
})

it("disconnects its observers on unmount", () => {
  const { unmount } = mountRegion()
  unmount()
  expect(ioDisconnect).toHaveBeenCalled()
})

it("stays visible and observes nothing when the ref is empty", () => {
  const ref = { current: null } as React.RefObject<HTMLElement>
  const { result } = renderHook(() => useRegionVisibility(ref))
  expect(result.current).toBe(true)
  expect(ioObserve).not.toHaveBeenCalled()
})

it("falls back to occlusion/visibility signals when IntersectionObserver is absent", async () => {
  ;(globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = undefined
  const { result, wrap } = mountRegion()
  // No IntersectionObserver → treated as on-screen, but modal occlusion still hides it.
  expect(result.current).toBe(true)
  await act(async () => {
    wrap.setAttribute("aria-hidden", "true")
  })
  expect(result.current).toBe(false)
})

it("ignores an empty IntersectionObserver batch", () => {
  const { result } = mountRegion()
  act(() => ioCallback?.([]))
  expect(result.current).toBe(true)
})
