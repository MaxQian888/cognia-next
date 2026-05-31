/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { useIsMobile } from "./use-mobile"

interface MQ {
  matches: boolean
  addEventListener: jest.Mock
  removeEventListener: jest.Mock
  triggerChange: () => void
}

function installMatchMedia(initialWidth: number): { mq: MQ; setWidth: (w: number) => void } {
  let listener: (() => void) | null = null
  const mq: MQ = {
    matches: initialWidth < 768,
    addEventListener: jest.fn((_evt: string, fn: () => void) => {
      listener = fn
    }),
    removeEventListener: jest.fn((_evt: string, fn: () => void) => {
      if (listener === fn) listener = null
    }),
    triggerChange: () => {
      listener?.()
    },
  }
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: initialWidth,
  })
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn().mockReturnValue(mq),
  })
  return {
    mq,
    setWidth: (w: number) => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: w,
      })
      mq.matches = w < 768
      mq.triggerChange()
    },
  }
}

function setCapacitorNative(on: boolean) {
  if (on) {
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    }
  } else {
    delete (window as { Capacitor?: unknown }).Capacitor
  }
}

afterEach(() => {
  setCapacitorNative(false)
})

describe("useIsMobile", () => {
  it("returns false when viewport is wider than the breakpoint", () => {
    installMatchMedia(1024)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })

  it("returns true when viewport is below the breakpoint", () => {
    installMatchMedia(500)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
  })

  it("flips when the matchMedia listener fires", () => {
    const { setWidth } = installMatchMedia(1200)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
    act(() => setWidth(400))
    expect(result.current).toBe(true)
    act(() => setWidth(900))
    expect(result.current).toBe(false)
  })

  it("removes the matchMedia listener on unmount", () => {
    const { mq } = installMatchMedia(1024)
    const { unmount } = renderHook(() => useIsMobile())
    expect(mq.addEventListener).toHaveBeenCalledWith("change", expect.any(Function))
    unmount()
    expect(mq.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function))
  })

  it("is pinned to true on a native mobile shell regardless of viewport width", () => {
    // iPad / large-tablet Capacitor case: 1200px viewport but native mobile.
    installMatchMedia(1200)
    setCapacitorNative(true)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
  })

  it("renders the desktop-default (false) server snapshot during SSR", () => {
    installMatchMedia(400) // narrow viewport, but SSR must ignore it
    const Probe = () => String(useIsMobile())
    expect(renderToStaticMarkup(createElement(Probe))).toBe("false")
  })
})
