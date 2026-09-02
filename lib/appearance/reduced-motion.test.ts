/** @jest-environment jsdom */

import {
  prefersReducedMotion,
  REDUCE_MOTION_CLASS,
  REDUCED_MOTION_QUERY,
  subscribeReducedMotion,
} from "./reduced-motion"

type Listener = () => void

interface FakeQuery {
  matches: boolean
  addEventListener?: (type: string, fn: Listener) => void
  removeEventListener?: (type: string, fn: Listener) => void
  addListener?: (fn: Listener) => void
  removeListener?: (fn: Listener) => void
}

const originalMatchMedia = window.matchMedia

function stubMatchMedia(query: FakeQuery | null): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: query === null ? undefined : jest.fn(() => query as unknown as MediaQueryList),
  })
}

afterEach(() => {
  document.documentElement.classList.remove(REDUCE_MOTION_CLASS)
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
})

describe("prefersReducedMotion", () => {
  it("reads the OS hint", () => {
    stubMatchMedia({ matches: true })
    expect(prefersReducedMotion()).toBe(true)

    stubMatchMedia({ matches: false })
    expect(prefersReducedMotion()).toBe(false)
  })

  it("lets the app's own opt-in win even when the OS says nothing", () => {
    // The gap this module exists to close: checking only the media query
    // silently ignores the in-app Reduce Motion switch.
    stubMatchMedia({ matches: false })
    document.documentElement.classList.add(REDUCE_MOTION_CLASS)
    expect(prefersReducedMotion()).toBe(true)
  })

  it("reports no preference when matchMedia is unavailable", () => {
    stubMatchMedia(null)
    expect(prefersReducedMotion()).toBe(false)
  })

  it("survives a matchMedia that throws", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("unsupported query")
      },
    })
    expect(prefersReducedMotion()).toBe(false)
  })

  it("queries the same media feature the stylesheet uses", () => {
    const spy = jest.fn(() => ({ matches: false }) as unknown as MediaQueryList)
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: spy })
    prefersReducedMotion()
    expect(spy).toHaveBeenCalledWith(REDUCED_MOTION_QUERY)
  })
})

describe("subscribeReducedMotion", () => {
  it("notifies on change and detaches on dispose", () => {
    const listeners: Listener[] = []
    stubMatchMedia({
      matches: false,
      addEventListener: (_type, fn) => listeners.push(fn),
      removeEventListener: (_type, fn) => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      },
    })

    const onChange = jest.fn()
    const dispose = subscribeReducedMotion(onChange)
    listeners[0]()
    expect(onChange).toHaveBeenCalledTimes(1)

    dispose()
    expect(listeners).toHaveLength(0)
  })

  it("falls back to the deprecated addListener API", () => {
    // WebKitGTK builds old enough to predate addEventListener on
    // MediaQueryList would otherwise never fire.
    const listeners: Listener[] = []
    stubMatchMedia({
      matches: false,
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      },
    })

    const onChange = jest.fn()
    const dispose = subscribeReducedMotion(onChange)
    listeners[0]()
    expect(onChange).toHaveBeenCalledTimes(1)
    dispose()
    expect(listeners).toHaveLength(0)
  })

  it("returns a callable disposer when matchMedia is missing", () => {
    stubMatchMedia(null)
    const dispose = subscribeReducedMotion(jest.fn())
    expect(() => dispose()).not.toThrow()
  })

  it("returns a callable disposer when matchMedia throws", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("nope")
      },
    })
    const dispose = subscribeReducedMotion(jest.fn())
    expect(() => dispose()).not.toThrow()
  })
})
