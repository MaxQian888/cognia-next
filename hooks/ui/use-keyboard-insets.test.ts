/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { useKeyboardInsets, useKeyboardViewport } from "./use-keyboard-insets"

jest.mock("@/hooks/use-platform", () => ({
  __esModule: true,
  usePlatform: jest.fn(),
}))
jest.mock("@/hooks/ui/use-compact-layout", () => ({
  useCompactLayout: jest.fn(() => false),
}))
jest.mock("@/hooks/ui/use-pointer", () => ({
  useCoarsePointer: jest.fn(() => false),
}))

import { usePlatform } from "@/hooks/use-platform"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { useCoarsePointer } from "@/hooks/ui/use-pointer"

const mockUsePlatform = usePlatform as jest.Mock
const mockCompact = useCompactLayout as jest.Mock
const mockCoarse = useCoarsePointer as jest.Mock

interface FakeVV {
  height: number
  offsetTop: number
  addEventListener: jest.Mock
  removeEventListener: jest.Mock
  fire: () => void
}

function installVisualViewport(initial: {
  height: number
  offsetTop?: number
  innerHeight: number
}): {
  vv: FakeVV
  setSize: (next: { height: number; offsetTop?: number; innerHeight?: number }) => void
} {
  const listeners = new Map<string, () => void>()
  const vv: FakeVV = {
    height: initial.height,
    offsetTop: initial.offsetTop ?? 0,
    addEventListener: jest.fn((event: string, fn: () => void) => {
      listeners.set(event, fn)
    }),
    removeEventListener: jest.fn((event: string) => {
      listeners.delete(event)
    }),
    fire: () => {
      listeners.get("resize")?.()
    },
  }
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    writable: true,
    value: vv,
  })
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: initial.innerHeight,
  })
  return {
    vv,
    setSize: ({ height, offsetTop, innerHeight }) => {
      vv.height = height
      if (offsetTop !== undefined) vv.offsetTop = offsetTop
      if (innerHeight !== undefined) {
        Object.defineProperty(window, "innerHeight", {
          configurable: true,
          writable: true,
          value: innerHeight,
        })
      }
      vv.fire()
    },
  }
}

type CapListener = (info?: { keyboardHeight: number }) => void

/**
 * Install a fake native Keyboard plugin on `window.Capacitor.Plugins` —
 * `makeDefaultLoader` resolves from that global first, so `subscribeKeyboard`
 * finds it regardless of the jsdom-detected platform.
 */
function installNativeKeyboard() {
  const listeners = new Map<string, CapListener>()
  const removed: string[] = []
  const plugin = {
    addListener: jest.fn(async (event: string, fn: CapListener) => {
      listeners.set(event, fn)
      return {
        remove: jest.fn(() => {
          removed.push(event)
        }),
      }
    }),
    hide: jest.fn(),
    show: jest.fn(),
  }
  ;(window as unknown as { Capacitor?: unknown }).Capacitor = {
    Plugins: { Keyboard: plugin },
  }
  return {
    plugin,
    removed,
    fire: (event: string, info?: { keyboardHeight: number }) => listeners.get(event)?.(info),
  }
}

describe("useKeyboardInsets", () => {
  beforeEach(() => {
    mockUsePlatform.mockReset()
    mockCompact.mockReset().mockReturnValue(false)
    mockCoarse.mockReset().mockReturnValue(false)
    delete (window as unknown as { Capacitor?: unknown }).Capacitor
  })

  it("returns zero insets on non-mobile platforms", () => {
    mockUsePlatform.mockReturnValue("web")
    installVisualViewport({ height: 600, innerHeight: 800 })
    const { result } = renderHook(() => useKeyboardInsets())
    expect(result.current).toEqual({ keyboardHeight: 0, isVisible: false })
  })

  it("returns zero insets when visualViewport is unavailable", () => {
    mockUsePlatform.mockReturnValue("mobile")
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      writable: true,
      value: undefined,
    })
    const { result } = renderHook(() => useKeyboardInsets())
    expect(result.current).toEqual({ keyboardHeight: 0, isVisible: false })
  })

  it("computes keyboardHeight from innerHeight - vv.height - vv.offsetTop", () => {
    mockUsePlatform.mockReturnValue("mobile")
    installVisualViewport({ height: 600, offsetTop: 0, innerHeight: 800 })
    const { result } = renderHook(() => useKeyboardInsets())
    expect(result.current).toEqual({ keyboardHeight: 200, isVisible: true })
  })

  it("clamps a negative computation to zero", () => {
    mockUsePlatform.mockReturnValue("mobile")
    installVisualViewport({ height: 1000, offsetTop: 0, innerHeight: 800 })
    const { result } = renderHook(() => useKeyboardInsets())
    expect(result.current).toEqual({ keyboardHeight: 0, isVisible: false })
  })

  it("updates when the visualViewport resize event fires", () => {
    mockUsePlatform.mockReturnValue("mobile")
    const { setSize } = installVisualViewport({ height: 800, innerHeight: 800 })
    const { result } = renderHook(() => useKeyboardInsets())
    expect(result.current.keyboardHeight).toBe(0)
    act(() => setSize({ height: 500, innerHeight: 800 }))
    expect(result.current.keyboardHeight).toBe(300)
    expect(result.current.isVisible).toBe(true)
    act(() => setSize({ height: 800, innerHeight: 800 }))
    expect(result.current.keyboardHeight).toBe(0)
    expect(result.current.isVisible).toBe(false)
  })

  it("removes listeners on unmount", () => {
    mockUsePlatform.mockReturnValue("mobile")
    const { vv } = installVisualViewport({ height: 800, innerHeight: 800 })
    const { unmount } = renderHook(() => useKeyboardInsets())
    expect(vv.addEventListener).toHaveBeenCalledWith("resize", expect.any(Function))
    expect(vv.addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function))
    unmount()
    expect(vv.removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function))
    expect(vv.removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function))
  })

  it("drives isVisible from native events even when the viewport overlap stays 0 (resize:native)", async () => {
    mockUsePlatform.mockReturnValue("mobile")
    installVisualViewport({ height: 800, innerHeight: 800 })
    const native = installNativeKeyboard()

    const { result } = renderHook(() => useKeyboardInsets())
    await act(async () => {}) // flush subscribeKeyboard

    // Native resize mode: frame shrank, overlap is 0 — but the keyboard IS open.
    act(() => native.fire("keyboardWillShow", { keyboardHeight: 320 }))
    expect(result.current).toEqual({ keyboardHeight: 0, isVisible: true })

    act(() => native.fire("keyboardWillHide"))
    expect(result.current).toEqual({ keyboardHeight: 0, isVisible: false })
  })

  it("keeps keyboardHeight as the layout OVERLAP so positioned consumers are not double-offset", async () => {
    mockUsePlatform.mockReturnValue("mobile")
    const { setSize } = installVisualViewport({ height: 800, innerHeight: 800 })
    const native = installNativeKeyboard()

    const { result } = renderHook(() => useKeyboardInsets())
    await act(async () => {})

    act(() => native.fire("keyboardWillShow", { keyboardHeight: 250 }))
    // Open, but no overlap yet — positioning consumers get 0 extra offset.
    expect(result.current).toEqual({ keyboardHeight: 0, isVisible: true })

    // A mode where the keyboard genuinely overlaps the layout viewport
    // (frame NOT resized): the overlap flows through unchanged.
    act(() => setSize({ height: 550, innerHeight: 800 }))
    expect(result.current).toEqual({ keyboardHeight: 250, isVisible: true })

    // Native close wins over a stale overlap for the open-state.
    act(() => native.fire("keyboardWillHide"))
    expect(result.current.isVisible).toBe(false)
  })

  it("removes native listeners on unmount", async () => {
    mockUsePlatform.mockReturnValue("mobile")
    installVisualViewport({ height: 800, innerHeight: 800 })
    const native = installNativeKeyboard()

    const { unmount } = renderHook(() => useKeyboardInsets())
    await act(async () => {})
    expect(native.plugin.addListener).toHaveBeenCalledTimes(4)

    unmount()
    expect(native.removed).toEqual(
      expect.arrayContaining([
        "keyboardWillShow",
        "keyboardDidShow",
        "keyboardWillHide",
        "keyboardDidHide",
      ])
    )
  })

  it("shares one native subscription across every consumer", async () => {
    mockUsePlatform.mockReturnValue("mobile")
    installVisualViewport({ height: 800, innerHeight: 800 })
    const native = installNativeKeyboard()

    const a = renderHook(() => useKeyboardInsets())
    const b = renderHook(() => useKeyboardViewport())
    await act(async () => {})
    expect(native.plugin.addListener).toHaveBeenCalledTimes(4)

    act(() => native.fire("keyboardWillShow", { keyboardHeight: 300 }))
    expect(a.result.current.isVisible).toBe(true)
    expect(b.result.current).toMatchObject({ open: true, nativeHeight: 300 })
    a.unmount()
    b.unmount()
  })

  it("publishes the visible height on <html> while open and clears it on unmount", () => {
    mockUsePlatform.mockReturnValue("mobile")
    const { setSize } = installVisualViewport({ height: 800, innerHeight: 800 })
    const { unmount } = renderHook(() => useKeyboardInsets())
    act(() => setSize({ height: 450, innerHeight: 800 }))
    const html = document.documentElement
    expect(html.style.getPropertyValue("--visual-viewport-height")).toBe("450px")
    expect(html.getAttribute("data-keyboard")).toBe("open")
    unmount()
    expect(html.style.getPropertyValue("--visual-viewport-height")).toBe("")
    expect(html.hasAttribute("data-keyboard")).toBe(false)
  })

  it("tracks a phone browser (compact layout + finger) as a soft-keyboard device", () => {
    mockUsePlatform.mockReturnValue("web")
    mockCompact.mockReturnValue(true)
    mockCoarse.mockReturnValue(true)
    const { setSize } = installVisualViewport({ height: 800, innerHeight: 800 })
    const { result } = renderHook(() => useKeyboardInsets())
    act(() => setSize({ height: 500, innerHeight: 800 }))
    expect(result.current).toEqual({ keyboardHeight: 300, isVisible: true })
  })

  it("ignores a narrow desktop window (compact layout, fine pointer)", () => {
    mockUsePlatform.mockReturnValue("web")
    mockCompact.mockReturnValue(true)
    mockCoarse.mockReturnValue(false)
    installVisualViewport({ height: 500, innerHeight: 800 })
    const { result } = renderHook(() => useKeyboardInsets())
    expect(result.current).toEqual({ keyboardHeight: 0, isVisible: false })
  })

  it("stays closed when the caller disables it", () => {
    mockUsePlatform.mockReturnValue("mobile")
    installVisualViewport({ height: 500, innerHeight: 800 })
    const { result } = renderHook(() => useKeyboardViewport(false))
    expect(result.current.open).toBe(false)
  })

  it("falls back to visualViewport when the native plugin never registers", () => {
    mockUsePlatform.mockReturnValue("mobile")
    const { setSize } = installVisualViewport({ height: 800, innerHeight: 800 })
    const { result } = renderHook(() => useKeyboardInsets())
    act(() => setSize({ height: 500, innerHeight: 800 }))
    expect(result.current).toEqual({ keyboardHeight: 300, isVisible: true })
  })
})
