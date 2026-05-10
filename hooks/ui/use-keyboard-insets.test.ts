/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { useKeyboardInsets } from "./use-keyboard-insets"

jest.mock("@/hooks/use-platform", () => ({
  __esModule: true,
  usePlatform: jest.fn(),
}))

import { usePlatform } from "@/hooks/use-platform"

const mockUsePlatform = usePlatform as jest.Mock

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

describe("useKeyboardInsets", () => {
  beforeEach(() => {
    mockUsePlatform.mockReset()
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
})
