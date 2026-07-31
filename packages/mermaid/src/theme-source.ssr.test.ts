/**
 * The no-DOM half of `theme-source`. Runs in the node environment on purpose:
 * jsdom's `document` is non-configurable, so the SSR branch cannot be reached
 * from the jsdom suite next door.
 *
 * This matters beyond coverage — the app is a static export, so these modules
 * are evaluated during prerender with no `document` and no `MutationObserver`.
 */

import { readMermaidTheme, resetMermaidThemeWatch, subscribeMermaidTheme } from "./theme-source"

describe("theme-source without a DOM", () => {
  afterEach(() => resetMermaidThemeWatch())

  it("reports the light theme", () => {
    expect(typeof document).toBe("undefined")
    expect(readMermaidTheme()).toBe("default")
  })

  it("accepts a subscription without wiring an observer, and unsubscribes cleanly", () => {
    const listener = jest.fn()

    const unsubscribe = subscribeMermaidTheme(listener)

    expect(listener).not.toHaveBeenCalled()
    expect(() => unsubscribe()).not.toThrow()
    // Idempotent: a component unmounting twice must not throw.
    expect(() => unsubscribe()).not.toThrow()
  })
})
