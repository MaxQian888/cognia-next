/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"
import { collectMatchRanges, useFindInPage } from "./use-find-in-page"

afterEach(() => {
  document.body.innerHTML = ""
  document.getElementById("cognia-find-highlight-styles")?.remove()
})

describe("collectMatchRanges", () => {
  it("returns one range per case-insensitive occurrence", () => {
    document.body.innerHTML = `<div id="root"><p>Foo bar FOO baz foo</p></div>`
    const root = document.getElementById("root")
    expect(collectMatchRanges(root, "foo")).toHaveLength(3)
  })

  it("returns nothing for an empty query or missing root", () => {
    document.body.innerHTML = `<div id="root">foo</div>`
    expect(collectMatchRanges(document.getElementById("root"), "")).toHaveLength(0)
    expect(collectMatchRanges(null, "foo")).toHaveLength(0)
  })

  it("skips [data-find-ignore] subtrees and script/style", () => {
    document.body.innerHTML = `
      <div id="root">
        <p>foo</p>
        <div data-find-ignore><span>foo</span></div>
        <script>foo</script>
        <style>foo</style>
      </div>`
    expect(collectMatchRanges(document.getElementById("root"), "foo")).toHaveLength(1)
  })
})

describe("useFindInPage", () => {
  it("stays empty while inactive", () => {
    document.body.innerHTML = `<div data-find-scope>foo foo</div>`
    const { result } = renderHook(() => useFindInPage(false))
    act(() => result.current.setQuery("foo"))
    expect(result.current.matchCount).toBe(0)
    expect(result.current.activeIndex).toBe(0)
  })

  it("counts matches and points at the first one when active", () => {
    document.body.innerHTML = `<div data-find-scope><p>foo foo foo</p></div>`
    const { result } = renderHook(() => useFindInPage(true))
    act(() => result.current.setQuery("foo"))
    expect(result.current.matchCount).toBe(3)
    expect(result.current.activeIndex).toBe(1)
  })

  it("cycles forward and wraps with next()", () => {
    document.body.innerHTML = `<div data-find-scope>ab ab</div>`
    const { result } = renderHook(() => useFindInPage(true))
    act(() => result.current.setQuery("ab"))
    expect(result.current.activeIndex).toBe(1)
    act(() => result.current.next())
    expect(result.current.activeIndex).toBe(2)
    act(() => result.current.next())
    expect(result.current.activeIndex).toBe(1) // wrapped
  })

  it("cycles backward and wraps with prev()", () => {
    document.body.innerHTML = `<div data-find-scope>ab ab</div>`
    const { result } = renderHook(() => useFindInPage(true))
    act(() => result.current.setQuery("ab"))
    act(() => result.current.prev())
    expect(result.current.activeIndex).toBe(2) // wrapped to last
  })

  it("resets to no matches when the query is cleared", () => {
    document.body.innerHTML = `<div data-find-scope>foo</div>`
    const { result } = renderHook(() => useFindInPage(true))
    act(() => result.current.setQuery("foo"))
    expect(result.current.matchCount).toBe(1)
    act(() => result.current.setQuery(""))
    expect(result.current.matchCount).toBe(0)
    act(() => result.current.next())
    expect(result.current.activeIndex).toBe(0)
  })

  it("falls back to <main> when there is no [data-find-scope]", () => {
    document.body.innerHTML = `<main><p>foo foo</p></main>`
    const { result } = renderHook(() => useFindInPage(true))
    act(() => result.current.setQuery("foo"))
    expect(result.current.matchCount).toBe(2)
  })

  it("falls back to document.body when there is neither a scope nor <main>", () => {
    document.body.innerHTML = `<section>foo</section>`
    const { result } = renderHook(() => useFindInPage(true))
    act(() => result.current.setQuery("foo"))
    expect(result.current.matchCount).toBe(1)
  })

  it("counts matches even when the CSS global is absent", () => {
    const originalCSS = (globalThis as { CSS?: unknown }).CSS
    ;(globalThis as { CSS?: unknown }).CSS = undefined
    try {
      document.body.innerHTML = `<div data-find-scope>foo foo</div>`
      const { result } = renderHook(() => useFindInPage(true))
      act(() => result.current.setQuery("foo"))
      expect(result.current.matchCount).toBe(2)
    } finally {
      ;(globalThis as { CSS?: unknown }).CSS = originalCSS
    }
  })

  it("treats a missing Highlight constructor as unsupported", () => {
    const set = jest.fn()
    const originalCSS = (globalThis as { CSS?: unknown }).CSS
    const originalHighlight = (globalThis as { Highlight?: unknown }).Highlight
    ;(globalThis as { CSS?: unknown }).CSS = { highlights: { set, delete: jest.fn() } }
    ;(globalThis as { Highlight?: unknown }).Highlight = undefined
    try {
      document.body.innerHTML = `<div data-find-scope>foo</div>`
      const { result } = renderHook(() => useFindInPage(true))
      act(() => result.current.setQuery("foo"))
      expect(result.current.matchCount).toBe(1)
      expect(set).not.toHaveBeenCalled()
    } finally {
      ;(globalThis as { CSS?: unknown }).CSS = originalCSS
      ;(globalThis as { Highlight?: unknown }).Highlight = originalHighlight
    }
  })

  it("swallows scrollIntoView failures", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView")
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      value: () => {
        throw new Error("boom")
      },
      configurable: true,
      writable: true,
    })
    try {
      document.body.innerHTML = `<div data-find-scope>foo</div>`
      const { result } = renderHook(() => useFindInPage(true))
      expect(() => act(() => result.current.setQuery("foo"))).not.toThrow()
      expect(result.current.matchCount).toBe(1)
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original)
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it("paints via the CSS Custom Highlight API when available", () => {
    const set = jest.fn()
    const del = jest.fn()
    const originalCSS = (globalThis as { CSS?: unknown }).CSS
    const originalHighlight = (globalThis as { Highlight?: unknown }).Highlight
    ;(globalThis as { CSS?: unknown }).CSS = { highlights: { set, delete: del } }
    ;(globalThis as { Highlight?: unknown }).Highlight = class {}
    // jsdom lacks scrollIntoView.
    const scrollSpy = jest.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      value: scrollSpy,
      configurable: true,
      writable: true,
    })

    try {
      document.body.innerHTML = `<div data-find-scope><p>foo foo</p></div>`
      const { result, unmount } = renderHook(() => useFindInPage(true))
      act(() => result.current.setQuery("foo"))
      // All-matches + active highlights registered; active scrolled into view.
      expect(set).toHaveBeenCalledWith("cognia-find", expect.anything())
      expect(set).toHaveBeenCalledWith("cognia-find-active", expect.anything())
      expect(scrollSpy).toHaveBeenCalled()
      unmount()
      expect(del).toHaveBeenCalledWith("cognia-find")
    } finally {
      ;(globalThis as { CSS?: unknown }).CSS = originalCSS
      ;(globalThis as { Highlight?: unknown }).Highlight = originalHighlight
    }
  })

  it("injects the ::highlight() styles once when the API is available", () => {
    const originalCSS = (globalThis as { CSS?: unknown }).CSS
    const originalHighlight = (globalThis as { Highlight?: unknown }).Highlight
    ;(globalThis as { CSS?: unknown }).CSS = { highlights: { set: jest.fn(), delete: jest.fn() } }
    ;(globalThis as { Highlight?: unknown }).Highlight = class {}
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      value: jest.fn(),
      configurable: true,
      writable: true,
    })

    try {
      document.body.innerHTML = `<div data-find-scope><p>foo foo</p></div>`
      const { result } = renderHook(() => useFindInPage(true))
      act(() => result.current.setQuery("foo"))

      const styles = document.head.querySelectorAll("#cognia-find-highlight-styles")
      expect(styles).toHaveLength(1)
      expect(styles[0].textContent).toContain("::highlight(cognia-find)")
      expect(styles[0].textContent).toContain("::highlight(cognia-find-active)")

      // Re-running the paint effect must not append a second <style>.
      act(() => result.current.next())
      expect(document.head.querySelectorAll("#cognia-find-highlight-styles")).toHaveLength(1)
    } finally {
      ;(globalThis as { CSS?: unknown }).CSS = originalCSS
      ;(globalThis as { Highlight?: unknown }).Highlight = originalHighlight
    }
  })

  it("does not inject the ::highlight() styles when the API is unavailable", () => {
    const originalCSS = (globalThis as { CSS?: unknown }).CSS
    ;(globalThis as { CSS?: unknown }).CSS = undefined
    try {
      document.body.innerHTML = `<div data-find-scope>foo</div>`
      const { result } = renderHook(() => useFindInPage(true))
      act(() => result.current.setQuery("foo"))
      expect(document.getElementById("cognia-find-highlight-styles")).toBeNull()
    } finally {
      ;(globalThis as { CSS?: unknown }).CSS = originalCSS
    }
  })
})
