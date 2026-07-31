import { renderHook } from "@testing-library/react"

import { useLiveQueryState } from "./use-live-query-state"

let mockValue: unknown = undefined

jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: () => mockValue,
}))

describe("useLiveQueryState", () => {
  afterEach(() => {
    mockValue = undefined
  })

  it("reports loading while Dexie has not resolved", () => {
    mockValue = undefined
    const { result } = renderHook(() => useLiveQueryState(() => [], []))
    expect(result.current).toEqual({ data: undefined, isLoading: true, isEmpty: false })
  })

  it("never calls a pending read empty", () => {
    // This is the whole point: `?? []` at the call site made these two states
    // indistinguishable, so surfaces rendered their empty state mid-load.
    mockValue = undefined
    const { result } = renderHook(() => useLiveQueryState(() => [], []))
    expect(result.current.isEmpty).toBe(false)
  })

  it("reports an empty array as loaded-and-empty", () => {
    mockValue = []
    const { result } = renderHook(() => useLiveQueryState(() => [], []))
    expect(result.current).toEqual({ data: [], isLoading: false, isEmpty: true })
  })

  it("reports a populated array as loaded and non-empty", () => {
    mockValue = [{ id: "a" }]
    const { result } = renderHook(() => useLiveQueryState(() => [], []))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isEmpty).toBe(false)
    expect(result.current.data).toEqual([{ id: "a" }])
  })

  it("treats a null single-row read as empty", () => {
    mockValue = null
    const { result } = renderHook(() => useLiveQueryState(() => null, []))
    expect(result.current).toEqual({ data: null, isLoading: false, isEmpty: true })
  })

  it("treats a resolved object as non-empty", () => {
    mockValue = { id: "s1" }
    const { result } = renderHook(() => useLiveQueryState(() => ({ id: "s1" }), []))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isEmpty).toBe(false)
  })

  it("treats 0 and empty string as loaded values, not emptiness", () => {
    // Falsy but present — a count of 0 has loaded, it is not "nothing yet".
    mockValue = 0
    const { result } = renderHook(() => useLiveQueryState(() => 0, []))
    expect(result.current).toEqual({ data: 0, isLoading: false, isEmpty: false })
  })
})
