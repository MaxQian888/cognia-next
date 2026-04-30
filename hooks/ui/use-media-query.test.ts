/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { useIsNarrow, useMediaQuery } from "./use-media-query"

function installMatchMedia(matches: boolean): {
  mq: {
    matches: boolean
    addEventListener: jest.Mock
    removeEventListener: jest.Mock
    triggerChange: () => void
  }
  matchMediaSpy: jest.Mock
} {
  let listener: (() => void) | null = null
  const mq = {
    matches,
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
  const matchMediaSpy = jest.fn().mockReturnValue(mq)
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: matchMediaSpy,
  })
  return { mq, matchMediaSpy }
}

describe("useMediaQuery", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: undefined,
    })
  })

  it("returns false when matchMedia is unavailable (SSR-like)", () => {
    const { result } = renderHook(() => useMediaQuery("(min-width: 1px)"))
    expect(result.current).toBe(false)
  })

  it("reflects the initial matchMedia.matches value", () => {
    installMatchMedia(true)
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"))
    expect(result.current).toBe(true)
  })

  it("updates when the listener fires", () => {
    const { mq } = installMatchMedia(false)
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"))
    expect(result.current).toBe(false)
    act(() => {
      mq.matches = true
      mq.triggerChange()
    })
    expect(result.current).toBe(true)
  })

  it("unsubscribes the listener on unmount", () => {
    const { mq } = installMatchMedia(true)
    const { unmount } = renderHook(() => useMediaQuery("(max-width: 100px)"))
    expect(mq.addEventListener).toHaveBeenCalledWith("change", expect.any(Function))
    unmount()
    expect(mq.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function))
  })
})

describe("useIsNarrow", () => {
  it("delegates to the (max-width: 767.98px) media query", () => {
    const { matchMediaSpy } = installMatchMedia(true)
    const { result } = renderHook(() => useIsNarrow())
    expect(result.current).toBe(true)
    expect(matchMediaSpy).toHaveBeenCalledWith("(max-width: 767.98px)")
  })
})
