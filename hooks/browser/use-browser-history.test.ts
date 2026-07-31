import { act, renderHook } from "@testing-library/react"

import { MAX_BROWSER_HISTORY, useBrowserHistory } from "./use-browser-history"

describe("useBrowserHistory", () => {
  it("keeps most-recent-first and collapses consecutive duplicates", () => {
    const { result } = renderHook(() => useBrowserHistory())
    act(() => result.current.push("a"))
    act(() => result.current.push("a"))
    act(() => result.current.push("b"))
    expect(result.current.recent).toEqual(["b", "a"])
  })

  it("moves an already-seen url to the front", () => {
    const { result } = renderHook(() => useBrowserHistory())
    act(() => result.current.push("a"))
    act(() => result.current.push("b"))
    act(() => result.current.push("a"))
    expect(result.current.recent).toEqual(["a", "b"])
  })

  it("ignores empty urls", () => {
    const { result } = renderHook(() => useBrowserHistory())
    act(() => result.current.push(""))
    expect(result.current.recent).toEqual([])
  })

  it(`caps the list at ${MAX_BROWSER_HISTORY} entries`, () => {
    const { result } = renderHook(() => useBrowserHistory())
    act(() => {
      for (let i = 0; i < MAX_BROWSER_HISTORY + 5; i++) result.current.push(`u${i}`)
    })
    expect(result.current.recent).toHaveLength(MAX_BROWSER_HISTORY)
    expect(result.current.recent[0]).toBe(`u${MAX_BROWSER_HISTORY + 4}`)
  })

  it("clears the whole list", () => {
    const { result } = renderHook(() => useBrowserHistory())
    act(() => result.current.push("a"))
    act(() => result.current.clear())
    expect(result.current.recent).toEqual([])
  })
})
