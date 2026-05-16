/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { useBreakpoint } from "./use-breakpoint"

interface MQ {
  query: string
  matches: boolean
  addEventListener: jest.Mock
  removeEventListener: jest.Mock
  trigger: () => void
}

function installMatchMedia(width: number): {
  setWidth: (w: number) => void
  queries: MQ[]
} {
  const queries: MQ[] = []

  const matchesFor = (query: string, w: number): boolean => {
    if (query === "(max-width: 767.98px)") return w < 768
    if (query === "(min-width: 768px) and (max-width: 1023.98px)") return w >= 768 && w < 1024
    return false
  }

  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  })

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => {
      let listener: (() => void) | null = null
      const mq: MQ = {
        query,
        matches: matchesFor(query, width),
        addEventListener: jest.fn((_evt: string, fn: () => void) => {
          listener = fn
        }),
        removeEventListener: jest.fn((_evt: string, fn: () => void) => {
          if (listener === fn) listener = null
        }),
        trigger: () => listener?.(),
      }
      queries.push(mq)
      return mq
    }),
  })

  return {
    queries,
    setWidth: (w: number) => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        writable: true,
        value: w,
      })
      queries.forEach((mq) => {
        mq.matches = matchesFor(mq.query, w)
        mq.trigger()
      })
    },
  }
}

describe("useBreakpoint", () => {
  it("returns 'mobile' for viewports < 768px", () => {
    installMatchMedia(400)
    const { result } = renderHook(() => useBreakpoint())
    expect(result.current).toBe("mobile")
  })

  it("returns 'tablet' for viewports 768–1023px", () => {
    installMatchMedia(820)
    const { result } = renderHook(() => useBreakpoint())
    expect(result.current).toBe("tablet")
  })

  it("returns 'desktop' for viewports >= 1024px", () => {
    installMatchMedia(1440)
    const { result } = renderHook(() => useBreakpoint())
    expect(result.current).toBe("desktop")
  })

  it("transitions across all three tiers on resize", () => {
    const { setWidth } = installMatchMedia(1440)
    const { result } = renderHook(() => useBreakpoint())
    expect(result.current).toBe("desktop")
    act(() => setWidth(820))
    expect(result.current).toBe("tablet")
    act(() => setWidth(400))
    expect(result.current).toBe("mobile")
    act(() => setWidth(1200))
    expect(result.current).toBe("desktop")
  })

  it("removes both media-query listeners on unmount", () => {
    const { queries } = installMatchMedia(820)
    const { unmount } = renderHook(() => useBreakpoint())
    expect(queries).toHaveLength(2)
    unmount()
    queries.forEach((mq) => {
      expect(mq.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function))
    })
  })
})
