/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { useCannotHover } from "./use-cannot-hover"

interface FakeMql {
  matches: boolean
  addEventListener: jest.Mock
  removeEventListener: jest.Mock
  fire: () => void
}

const originalMatchMedia = window.matchMedia

function installMatchMedia(truthy: Set<string>): Map<string, FakeMql> {
  const mqls = new Map<string, FakeMql>()
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string): FakeMql => {
      const cached = mqls.get(query)
      if (cached) return cached
      let listener: (() => void) | null = null
      const mql: FakeMql = {
        matches: truthy.has(query),
        addEventListener: jest.fn((_evt: string, fn: () => void) => {
          listener = fn
        }),
        removeEventListener: jest.fn((_evt: string, fn: () => void) => {
          if (listener === fn) listener = null
        }),
        fire: () => listener?.(),
      }
      mqls.set(query, mql)
      return mql
    }),
  })
  return mqls
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
})

describe("useCannotHover", () => {
  it("is true where the device reports it cannot hover", () => {
    installMatchMedia(new Set(["(hover: none)", "(pointer: coarse)"]))
    const { result } = renderHook(() => useCannotHover())
    expect(result.current).toBe(true)
  })

  it("is false on a hover-capable device", () => {
    installMatchMedia(new Set(["(hover: hover)"]))
    const { result } = renderHook(() => useCannotHover())
    expect(result.current).toBe(false)
  })

  it("is false where neither hover query matches", () => {
    installMatchMedia(new Set())
    const { result } = renderHook(() => useCannotHover())
    expect(result.current).toBe(false)
  })

  it("follows a change of the primary pointer", () => {
    const mqls = installMatchMedia(new Set())
    const { result } = renderHook(() => useCannotHover())
    act(() => {
      const mql = mqls.get("(hover: none)")!
      mql.matches = true
      mql.fire()
    })
    expect(result.current).toBe(true)
  })

  it("is false without matchMedia (the SSR default)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: undefined,
    })
    const { result } = renderHook(() => useCannotHover())
    expect(result.current).toBe(false)
  })
})
