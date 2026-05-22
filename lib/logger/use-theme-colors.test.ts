/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import { useThemeColors, DEFAULT_THEME_COLORS, THEME_KEYS } from "./use-theme-colors"

describe("useThemeColors", () => {
  let observers: MutationObserver[] = []
  const OriginalMutationObserver = global.MutationObserver

  beforeEach(() => {
    observers = []
    // Capture every observer instance so tests can trigger their callback
    // and assert disconnect was called on unmount.
    class TrackedObserver implements MutationObserver {
      callback: MutationCallback
      disconnect = jest.fn()
      observe = jest.fn()
      takeRecords = jest.fn(() => [] as MutationRecord[])
      constructor(cb: MutationCallback) {
        this.callback = cb
        observers.push(this as unknown as MutationObserver)
      }
    }
    global.MutationObserver = TrackedObserver as unknown as typeof MutationObserver
    // Reset html class so each test starts clean.
    document.documentElement.className = ""
  })

  afterEach(() => {
    global.MutationObserver = OriginalMutationObserver
    document.documentElement.className = ""
  })

  it("returns the static defaults before mount and after effect when CSS vars are unset", () => {
    const { result } = renderHook(() => useThemeColors())
    // jsdom doesn't compute CSS vars from stylesheet imports, so they read empty
    // and the hook falls back to DEFAULT_THEME_COLORS.
    for (const key of THEME_KEYS) {
      expect(result.current[key]).toBe(DEFAULT_THEME_COLORS[key])
    }
  })

  it("reads inline CSS variables from documentElement when present", () => {
    document.documentElement.style.setProperty("--success", "oklch(0.5 0.2 150)")
    document.documentElement.style.setProperty("--destructive", "oklch(0.6 0.3 25)")

    const { result } = renderHook(() => useThemeColors())

    expect(result.current.success).toBe("oklch(0.5 0.2 150)")
    expect(result.current.destructive).toBe("oklch(0.6 0.3 25)")
    // Unspecified vars stay on defaults.
    expect(result.current.warning).toBe(DEFAULT_THEME_COLORS.warning)
  })

  it("re-reads variables when the documentElement class mutates", () => {
    document.documentElement.style.setProperty("--success", "oklch(0.1 0 0)")
    const { result } = renderHook(() => useThemeColors())
    expect(result.current.success).toBe("oklch(0.1 0 0)")

    // Simulate next-themes flipping dark mode and re-defining --success.
    act(() => {
      document.documentElement.style.setProperty("--success", "oklch(0.9 0 0)")
      const obs = observers[observers.length - 1] as unknown as { callback: MutationCallback }
      obs.callback([], obs as unknown as MutationObserver)
    })

    expect(result.current.success).toBe("oklch(0.9 0 0)")
  })

  it("falls back to defaults when computed value is whitespace-only", () => {
    document.documentElement.style.setProperty("--warning", "   ")
    const { result } = renderHook(() => useThemeColors())
    expect(result.current.warning).toBe(DEFAULT_THEME_COLORS.warning)
  })

  it("disconnects the MutationObserver on unmount", () => {
    const { unmount } = renderHook(() => useThemeColors())
    const observer = observers[observers.length - 1] as unknown as { disconnect: jest.Mock }
    unmount()
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
  })

  it("observes both `class` and `style` attributes on documentElement", () => {
    // `style` is observed so inline-style writes from `CustomThemeApplier`
    // (the appearance v47 path) propagate into chart colors. The previous
    // implementation only watched `class` and silently dropped every
    // custom-theme update.
    renderHook(() => useThemeColors())
    const observer = observers[observers.length - 1] as unknown as {
      observe: jest.Mock
    }
    expect(observer.observe).toHaveBeenCalledTimes(1)
    const [target, init] = observer.observe.mock.calls[0]
    expect(target).toBe(document.documentElement)
    expect(init).toEqual({ attributes: true, attributeFilter: ["class", "style"] })
  })
})
