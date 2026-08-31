/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { useCompactLayout } from "./use-compact-layout"

function installMatchMedia(initialWidth: number): { setWidth: (w: number) => void } {
  let listener: (() => void) | null = null
  const mq = {
    matches: initialWidth < 768,
    addEventListener: jest.fn((_evt: string, fn: () => void) => {
      listener = fn
    }),
    removeEventListener: jest.fn((_evt: string, fn: () => void) => {
      if (listener === fn) listener = null
    }),
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn().mockReturnValue(mq),
  })
  return {
    setWidth: (w: number) => {
      mq.matches = w < 768
      listener?.()
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

describe("useCompactLayout", () => {
  it("is true for a narrow viewport with no native shell", () => {
    // The case the repo used to get wrong: a 375px BROWSER is narrow, and
    // `usePlatform() === "mobile"` answered false for it.
    installMatchMedia(375)
    const { result } = renderHook(() => useCompactLayout())
    expect(result.current).toBe(true)
  })

  it("is false for a wide viewport with no native shell", () => {
    installMatchMedia(1440)
    const { result } = renderHook(() => useCompactLayout())
    expect(result.current).toBe(false)
  })

  it("is true on a native mobile shell even on a tablet-width viewport", () => {
    installMatchMedia(1200)
    setCapacitorNative(true)
    const { result } = renderHook(() => useCompactLayout())
    expect(result.current).toBe(true)
  })

  it("tracks viewport changes so a resized desktop window swaps layout", () => {
    const { setWidth } = installMatchMedia(1200)
    const { result } = renderHook(() => useCompactLayout())
    expect(result.current).toBe(false)
    act(() => setWidth(375))
    expect(result.current).toBe(true)
    act(() => setWidth(1200))
    expect(result.current).toBe(false)
  })

  it("renders the desktop-default server snapshot during SSR", () => {
    installMatchMedia(375)
    const Probe = () => String(useCompactLayout())
    expect(renderToStaticMarkup(createElement(Probe))).toBe("false")
  })
})
