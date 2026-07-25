import { renderHook } from "@testing-library/react"

import { useDesktopAvailable } from "./use-desktop-available"

// `isTauri()` keys on a `window` marker. SWC-compiled `export function` bindings
// are non-configurable, so `jest.spyOn` can't replace it — drive the real marker
// instead, which is also what the production code actually reads.
const MARKER = "__TAURI_INTERNALS__"

function setDesktop(on: boolean) {
  if (on) {
    ;(window as unknown as Record<string, unknown>)[MARKER] = {}
  } else {
    delete (window as unknown as Record<string, unknown>)[MARKER]
  }
}

afterEach(() => setDesktop(false))

describe("useDesktopAvailable", () => {
  it("is false in web mode", () => {
    setDesktop(false)
    const { result } = renderHook(() => useDesktopAvailable())
    expect(result.current).toBe(false)
  })

  it("is true inside the Tauri webview", () => {
    setDesktop(true)
    const { result } = renderHook(() => useDesktopAvailable())
    expect(result.current).toBe(true)
  })

  it("resolves synchronously — no timer has to flush first", () => {
    jest.useFakeTimers()
    try {
      setDesktop(true)
      const { result } = renderHook(() => useDesktopAvailable())
      // The previous implementation needed a `setTimeout(0)` to flip; this must
      // already be settled before any timer runs, otherwise the nav list pops.
      expect(result.current).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it("stays stable across re-renders", () => {
    setDesktop(true)
    const { result, rerender } = renderHook(() => useDesktopAvailable())
    rerender()
    rerender()
    expect(result.current).toBe(true)
  })
})
