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

  // Back/forward enablement has to be modelled here: neither webview exposes
  // `canGoBack` through Tauri, so the buttons were previously always enabled
  // and Back on the first page silently did nothing.
  describe("back / forward stack", () => {
    it("starts with nowhere to go", () => {
      const { result } = renderHook(() => useBrowserHistory())
      expect(result.current.canGoBack).toBe(false)
      expect(result.current.canGoForward).toBe(false)
      expect(result.current.index).toBe(-1)
    })

    it("cannot go back from the first page", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.push("a"))
      expect(result.current.canGoBack).toBe(false)
      expect(result.current.canGoForward).toBe(false)
      expect(result.current.goBack()).toBeNull()
    })

    it("walks back and forward through the stack", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.push("a"))
      act(() => result.current.push("b"))
      act(() => result.current.push("c"))
      expect(result.current.canGoBack).toBe(true)
      expect(result.current.canGoForward).toBe(false)

      act(() => void result.current.goBack())
      expect(result.current.entries[result.current.index]).toBe("b")
      expect(result.current.canGoForward).toBe(true)

      act(() => void result.current.goForward())
      expect(result.current.entries[result.current.index]).toBe("c")
      expect(result.current.canGoForward).toBe(false)
      expect(result.current.goForward()).toBeNull()
    })

    it("truncates the forward entries when a new page is pushed after going back", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.push("a"))
      act(() => result.current.push("b"))
      act(() => result.current.push("c"))
      act(() => void result.current.goBack())
      act(() => result.current.push("d"))
      expect(result.current.entries).toEqual(["a", "b", "d"])
      expect(result.current.canGoForward).toBe(false)
    })

    it("overwrites the current entry on replace, without growing the stack", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.push("a"))
      act(() => result.current.push("b"))
      act(() => result.current.replace("b2"))
      expect(result.current.entries).toEqual(["a", "b2"])
      expect(result.current.canGoBack).toBe(true)
      expect(result.current.canGoForward).toBe(false)
    })

    it("seeds the stack when replace lands first", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.replace("a"))
      expect(result.current.entries).toEqual(["a"])
      expect(result.current.index).toBe(0)
    })

    it("moves the index without mutating the stack on a page-driven traversal", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.push("a"))
      act(() => result.current.push("b"))
      act(() => result.current.push("c"))
      act(() => result.current.traverseTo("a"))
      expect(result.current.entries).toEqual(["a", "b", "c"])
      expect(result.current.index).toBe(0)
      expect(result.current.canGoForward).toBe(true)
    })

    it("leaves the index alone for an ambiguous or unknown traversal", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.push("a"))
      act(() => result.current.push("b"))
      act(() => result.current.push("a"))
      // "a" appears twice: guessing a position would desync the stack.
      act(() => result.current.traverseTo("a"))
      expect(result.current.index).toBe(2)
      act(() => result.current.traverseTo("zzz"))
      expect(result.current.index).toBe(2)
    })

    it("resets the position on clear", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.push("a"))
      act(() => result.current.push("b"))
      act(() => result.current.clear())
      expect(result.current.entries).toEqual([])
      expect(result.current.index).toBe(-1)
      expect(result.current.canGoBack).toBe(false)
    })
  })
})
