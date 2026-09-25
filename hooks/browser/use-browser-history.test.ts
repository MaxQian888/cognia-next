import { act, renderHook } from "@testing-library/react"

jest.mock("@/lib/db/browser-history", () => ({ recordBrowserVisit: jest.fn() }))
jest.mock("@cognia/logging", () => ({ loggers: { store: { warn: jest.fn() } } }))

import { loggers } from "@cognia/logging"
import { recordBrowserVisit } from "@/lib/db/browser-history"
import { useBrowserHistory } from "./use-browser-history"

const record = recordBrowserVisit as jest.Mock

beforeEach(() => {
  record.mockReset().mockResolvedValue(undefined)
  ;(loggers.store.warn as jest.Mock).mockClear()
})

describe("useBrowserHistory", () => {
  // The stack is a position and dies with the pane; the places visited are
  // what the history menu lists, so each arrival is written through.
  describe("visit recording", () => {
    it("records each page the pane arrives at", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.push("https://a.example/"))
      act(() => result.current.push("https://b.example/"))
      expect(record.mock.calls.map(([url]) => url)).toEqual([
        "https://a.example/",
        "https://b.example/",
      ])
    })

    it("does not record a repeat of the page it is already on", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.push("https://a.example/"))
      act(() => result.current.push("https://a.example/"))
      expect(record).toHaveBeenCalledTimes(1)
    })

    it("records an in-place replace and a step back as arrivals", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.push("https://a.example/"))
      act(() => result.current.push("https://b.example/"))
      act(() => result.current.replace("https://b.example/next"))
      act(() => {
        result.current.goBack()
      })
      expect(record.mock.calls.map(([url]) => url)).toEqual([
        "https://a.example/",
        "https://b.example/",
        "https://b.example/next",
        "https://a.example/",
      ])
    })

    it("ignores empty urls", () => {
      const { result } = renderHook(() => useBrowserHistory())
      act(() => result.current.push(""))
      expect(result.current.entries).toEqual([])
      expect(record).not.toHaveBeenCalled()
    })

    it("keeps browsing when a history write fails", async () => {
      record.mockRejectedValue(new Error("quota"))
      const { result } = renderHook(() => useBrowserHistory())
      await act(async () => {
        result.current.push("https://a.example/")
        await Promise.resolve()
      })
      expect(result.current.entries).toEqual(["https://a.example/"])
      expect(loggers.store.warn).toHaveBeenCalled()
    })
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
  })
})
