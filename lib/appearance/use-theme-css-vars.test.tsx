/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"
import { __resetOklchSupportProbeForTesting, useThemeCssVars } from "./use-theme-css-vars"

const KEYS = ["--primary", "--background"] as const
const DEFAULTS: Record<(typeof KEYS)[number], string> = {
  "--primary": "#3b82f6",
  "--background": "#ffffff",
}

beforeEach(() => {
  document.documentElement.removeAttribute("style")
  document.documentElement.removeAttribute("class")
  __resetOklchSupportProbeForTesting()
})

describe("useThemeCssVars", () => {
  it("returns the supplied defaults when the CSS variables are not set", () => {
    const { result } = renderHook(() => useThemeCssVars(KEYS, DEFAULTS))
    expect(result.current["--primary"]).toBe("#3b82f6")
    expect(result.current["--background"]).toBe("#ffffff")
  })

  it("reads live values written as inline styles on <html>", () => {
    document.documentElement.style.setProperty("--primary", "oklch(0.7 0.2 30)")
    document.documentElement.style.setProperty("--background", "#000000")

    const { result } = renderHook(() => useThemeCssVars(KEYS, DEFAULTS))

    expect(result.current["--primary"]).toBe("oklch(0.7 0.2 30)")
    expect(result.current["--background"]).toBe("#000000")
  })

  it("re-reads when the inline `style` attribute on <html> mutates", async () => {
    const { result } = renderHook(() => useThemeCssVars(KEYS, DEFAULTS))
    expect(result.current["--primary"]).toBe("#3b82f6")

    await act(async () => {
      document.documentElement.style.setProperty("--primary", "#ff0000")
      // MutationObserver dispatches on the next microtask.
      await Promise.resolve()
    })

    expect(result.current["--primary"]).toBe("#ff0000")
  })

  it("re-reads when the `class` attribute on <html> mutates", async () => {
    const { result } = renderHook(() => useThemeCssVars(KEYS, DEFAULTS))

    await act(async () => {
      document.documentElement.classList.add("dark")
      // No CSS var defined here, but the read must still fire.
      document.documentElement.style.setProperty("--primary", "#222222")
      await Promise.resolve()
    })

    expect(result.current["--primary"]).toBe("#222222")
  })

  it("returns hex when the resolved value is oklch and `canvasSafe` is true on a non-oklch UA", async () => {
    // Force the probe to think oklch is unsupported.
    const originalSupports = CSS.supports
    Object.defineProperty(CSS, "supports", {
      configurable: true,
      writable: true,
      value: () => false,
    })

    try {
      document.documentElement.style.setProperty("--primary", "rgb(255, 0, 0)")
      const { result } = renderHook(() => useThemeCssVars(KEYS, DEFAULTS, { canvasSafe: true }))
      expect(result.current["--primary"].toLowerCase()).toBe("#ff0000")
    } finally {
      Object.defineProperty(CSS, "supports", {
        configurable: true,
        writable: true,
        value: originalSupports,
      })
    }
  })

  it("passes through oklch when `canvasSafe` is false (default)", () => {
    document.documentElement.style.setProperty("--primary", "oklch(0.7 0.2 30)")
    const { result } = renderHook(() => useThemeCssVars(KEYS, DEFAULTS))
    expect(result.current["--primary"]).toBe("oklch(0.7 0.2 30)")
  })

  it("disconnects the observer on unmount", async () => {
    const { unmount, result } = renderHook(() => useThemeCssVars(KEYS, DEFAULTS))
    unmount()

    await act(async () => {
      document.documentElement.style.setProperty("--primary", "#111111")
      await Promise.resolve()
    })

    // The hook is unmounted; the snapshot must remain at whatever it was.
    expect(result.current["--primary"]).toBe("#3b82f6")
  })
})
