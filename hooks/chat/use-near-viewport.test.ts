/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"
import { createRef } from "react"

import { DEFAULT_LOOK_AHEAD_SCREENS, isWithinLookAhead, useNearViewport } from "./use-near-viewport"

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void

interface FakeObserver {
  callback: ObserverCallback
  options: IntersectionObserverInit | undefined
  observed: Element[]
  disconnected: boolean
}

let observers: FakeObserver[] = []
const realIntersectionObserver = globalThis.IntersectionObserver

function installFakeObserver() {
  observers = []
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    constructor(callback: ObserverCallback, options?: IntersectionObserverInit) {
      const self: FakeObserver = { callback, options, observed: [], disconnected: false }
      observers.push(self)
      this.observe = (el: Element) => self.observed.push(el)
      this.disconnect = () => {
        self.disconnected = true
      }
    }
    observe: (el: Element) => void
    disconnect: () => void
  }
}

/** jsdom returns an all-zero rect; stub a real one to place the element. */
function elementAt(top: number, height = 100): HTMLDivElement {
  const el = document.createElement("div")
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect
  return el
}

function mount(el: HTMLElement, options?: Parameters<typeof useNearViewport>[1]) {
  const ref = createRef<HTMLDivElement>() as { current: HTMLElement | null }
  ref.current = el
  return renderHook(() => useNearViewport(ref, options))
}

describe("isWithinLookAhead", () => {
  it("accepts an element inside the viewport", () => {
    expect(isWithinLookAhead(elementAt(10), 1)).toBe(true)
  })

  it("accepts an element inside the look-ahead band below the fold", () => {
    // innerHeight is 768 in jsdom; one screen of look-ahead reaches 1536.
    expect(isWithinLookAhead(elementAt(1500), 1)).toBe(true)
  })

  it("rejects an element beyond the look-ahead band", () => {
    expect(isWithinLookAhead(elementAt(5000), 1)).toBe(false)
  })

  it("rejects an element scrolled far above the band", () => {
    expect(isWithinLookAhead(elementAt(-5000), 1)).toBe(false)
  })

  it("widens the band with more screens of look-ahead", () => {
    expect(isWithinLookAhead(elementAt(2000), 1)).toBe(false)
    expect(isWithinLookAhead(elementAt(2000), 3)).toBe(true)
  })

  it("says yes when the element cannot be measured at all", () => {
    // Content must never be withheld because an API is missing.
    const unmeasurable = { getBoundingClientRect: undefined } as unknown as Element
    expect(isWithinLookAhead(unmeasurable, 1)).toBe(true)
  })
})

describe("useNearViewport", () => {
  afterEach(() => {
    if (realIntersectionObserver) {
      ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
        realIntersectionObserver
    } else {
      delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    }
  })

  it("latches immediately for an element already near, without an observer", () => {
    installFakeObserver()

    const { result } = mount(elementAt(10))

    expect(result.current).toBe(true)
    expect(observers).toHaveLength(0)
  })

  it("reports visible immediately when disabled", () => {
    installFakeObserver()

    const { result } = mount(elementAt(9999), { disabled: true })

    expect(result.current).toBe(true)
    expect(observers).toHaveLength(0)
  })

  it("observes a far-away element and flips when it comes near", () => {
    installFakeObserver()

    const { result } = mount(elementAt(9999))
    expect(result.current).toBe(false)
    expect(observers).toHaveLength(1)

    act(() => observers[0].callback([{ isIntersecting: true }]))

    expect(result.current).toBe(true)
  })

  it("does not strand content when the browser has no observer at all", () => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver

    const { result } = mount(elementAt(9999))

    expect(result.current).toBe(true)
  })

  it("ignores callbacks that report no intersection", () => {
    installFakeObserver()

    const { result } = mount(elementAt(9999))
    act(() => observers[0].callback([{ isIntersecting: false }]))

    expect(result.current).toBe(false)
    expect(observers[0].disconnected).toBe(false)
  })

  it("latches: a later scroll-away does not take it back", () => {
    installFakeObserver()

    const { result } = mount(elementAt(9999))
    act(() => observers[0].callback([{ isIntersecting: true }]))
    act(() => observers[0].callback([{ isIntersecting: false }]))

    expect(result.current).toBe(true)
  })

  it("disconnects once latched, so scrolling costs nothing after", () => {
    installFakeObserver()

    const { result } = mount(elementAt(9999))
    act(() => observers[0].callback([{ isIntersecting: true }]))

    expect(result.current).toBe(true)
    expect(observers[0].disconnected).toBe(true)
    expect(observers).toHaveLength(1)
  })

  it("builds the observer margin from the look-ahead screens", () => {
    installFakeObserver()

    mount(elementAt(99999))
    expect(observers[0].options?.rootMargin).toBe(`${DEFAULT_LOOK_AHEAD_SCREENS * 100}% 0px`)

    mount(elementAt(99999), { lookAheadScreens: 2 })
    expect(observers[1].options?.rootMargin).toBe("200% 0px")
  })

  it("does nothing when the ref has no element yet", () => {
    installFakeObserver()
    const ref = createRef<HTMLDivElement>()

    const { result } = renderHook(() => useNearViewport(ref))

    expect(result.current).toBe(false)
    expect(observers).toHaveLength(0)
  })

  it("disconnects on unmount", () => {
    installFakeObserver()

    const { unmount } = mount(elementAt(9999))
    unmount()

    expect(observers[0].disconnected).toBe(true)
  })
})
