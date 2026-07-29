/** @jest-environment jsdom */

import { readMermaidTheme, resetMermaidThemeWatch, subscribeMermaidTheme } from "./theme-source"

/** MutationObserver callbacks land on a microtask; give them one to run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("readMermaidTheme", () => {
  afterEach(() => {
    document.documentElement.className = ""
    resetMermaidThemeWatch()
  })

  it("follows the global dark class", () => {
    expect(readMermaidTheme()).toBe("default")
    document.documentElement.classList.add("dark")
    expect(readMermaidTheme()).toBe("dark")
  })

  // The no-document (SSR / static-export prerender) branch lives in
  // `theme-source.ssr.test.ts`: jsdom's `document` is non-configurable, so it
  // can only be observed from the node environment.
})

describe("subscribeMermaidTheme", () => {
  afterEach(() => {
    document.documentElement.className = ""
    resetMermaidThemeWatch()
  })

  it("notifies every subscriber on a theme flip", async () => {
    const first = jest.fn()
    const second = jest.fn()
    subscribeMermaidTheme(first)
    subscribeMermaidTheme(second)

    document.documentElement.classList.add("dark")
    await flush()

    expect(first).toHaveBeenCalledWith("dark")
    expect(second).toHaveBeenCalledWith("dark")
  })

  it("stays quiet for class changes that are not a theme flip", async () => {
    const listener = jest.fn()
    subscribeMermaidTheme(listener)

    // The old per-block observers woke on any attribute change to <html>.
    document.documentElement.classList.add("reduce-motion", "font-large")
    await flush()

    expect(listener).not.toHaveBeenCalled()
  })

  it("does not re-notify when the theme lands on the value it already had", async () => {
    const listener = jest.fn()
    subscribeMermaidTheme(listener)

    document.documentElement.classList.add("dark")
    await flush()
    document.documentElement.classList.add("dense")
    await flush()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("stops notifying an unsubscribed listener but keeps serving the rest", async () => {
    const staying = jest.fn()
    const leaving = jest.fn()
    subscribeMermaidTheme(staying)
    const unsubscribe = subscribeMermaidTheme(leaving)

    unsubscribe()
    document.documentElement.classList.add("dark")
    await flush()

    expect(leaving).not.toHaveBeenCalled()
    expect(staying).toHaveBeenCalledWith("dark")
  })

  it("tears the observer down once the last subscriber leaves, and rebuilds on the next", async () => {
    const first = jest.fn()
    subscribeMermaidTheme(first)()

    document.documentElement.classList.add("dark")
    await flush()
    expect(first).not.toHaveBeenCalled()

    // Re-subscribing against an already-dark document must not fire for the
    // state it starts in — only for the next flip.
    const second = jest.fn()
    subscribeMermaidTheme(second)
    await flush()
    expect(second).not.toHaveBeenCalled()

    document.documentElement.classList.remove("dark")
    await flush()
    expect(second).toHaveBeenCalledWith("default")
  })

  it("survives being reset while subscribers are attached", () => {
    subscribeMermaidTheme(jest.fn())
    expect(() => resetMermaidThemeWatch()).not.toThrow()
  })
})
