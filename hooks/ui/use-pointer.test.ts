/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { useCoarsePointer, useHasHover } from "./use-pointer"

interface FakeMql {
  matches: boolean
  addEventListener: jest.Mock
  removeEventListener: jest.Mock
  fire: () => void
}

/** Installs a matchMedia that answers per-query from `truthy`. */
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
    value: undefined,
  })
})

describe("useHasHover", () => {
  it("is true on a hover-capable (desktop) device", () => {
    installMatchMedia(new Set(["(hover: hover)"]))
    const { result } = renderHook(() => useHasHover())
    expect(result.current).toBe(true)
  })

  it("is false on a touch device", () => {
    installMatchMedia(new Set(["(pointer: coarse)"]))
    const { result } = renderHook(() => useHasHover())
    expect(result.current).toBe(false)
  })

  it("defaults to true when matchMedia is unavailable (SSR)", () => {
    const { result } = renderHook(() => useHasHover())
    expect(result.current).toBe(true)
  })
})

describe("useCoarsePointer", () => {
  it("is true on a coarse-pointer (touch) device", () => {
    installMatchMedia(new Set(["(pointer: coarse)"]))
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(true)
  })

  it("is false on a fine-pointer (mouse) device and reacts to changes", () => {
    const mqls = installMatchMedia(new Set())
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(false)
    act(() => {
      const mql = mqls.get("(pointer: coarse)")!
      mql.matches = true
      mql.fire()
    })
    expect(result.current).toBe(true)
  })
})
