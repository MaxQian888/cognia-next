/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import { useKeyboardViewportPin } from "./use-keyboard-viewport-pin"

const keyboardState = { open: false }
const keyboardEnabledCalls: boolean[] = []
jest.mock("@/hooks/ui/use-keyboard-insets", () => ({
  useKeyboardViewport: (enabled: boolean) => {
    keyboardEnabledCalls.push(enabled)
    return { open: keyboardState.open, overlap: 0, viewportHeight: 0, nativeHeight: 0 }
  },
}))

interface FakeViewport extends EventTarget {
  offsetTop: number
  scale: number
}

let vv: FakeViewport
const scrollTo = jest.fn()

beforeEach(() => {
  keyboardState.open = false
  keyboardEnabledCalls.length = 0
  scrollTo.mockReset()
  vv = new EventTarget() as FakeViewport
  vv.offsetTop = 0
  vv.scale = 1
  Object.defineProperty(window, "visualViewport", { configurable: true, value: vv })
  Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 })
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo
})

function setScrollY(value: number) {
  Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value })
}

describe("useKeyboardViewportPin", () => {
  it("does nothing while the keyboard is closed", () => {
    setScrollY(120)
    renderHook(() => useKeyboardViewportPin(true))
    act(() => {
      window.dispatchEvent(new Event("scroll"))
    })
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it("undoes a root scroll the browser made to reveal the focused input", () => {
    keyboardState.open = true
    setScrollY(140)
    renderHook(() => useKeyboardViewportPin(true))
    expect(scrollTo).toHaveBeenCalledWith(0, 0)

    scrollTo.mockClear()
    setScrollY(0)
    act(() => {
      window.dispatchEvent(new Event("scroll"))
    })
    expect(scrollTo).not.toHaveBeenCalled()

    setScrollY(60)
    act(() => {
      window.dispatchEvent(new Event("scroll"))
    })
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it("undoes a visual-viewport pan", () => {
    keyboardState.open = true
    renderHook(() => useKeyboardViewportPin(true))
    scrollTo.mockClear()
    vv.offsetTop = 180
    act(() => {
      vv.dispatchEvent(new Event("scroll"))
    })
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it("leaves a pinch-zoomed viewport alone", () => {
    keyboardState.open = true
    vv.scale = 2
    vv.offsetTop = 180
    setScrollY(50)
    renderHook(() => useKeyboardViewportPin(true))
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it("is inert when disabled (document-scrolling routes)", () => {
    keyboardState.open = true
    setScrollY(140)
    renderHook(() => useKeyboardViewportPin(false))
    expect(scrollTo).not.toHaveBeenCalled()
    expect(keyboardEnabledCalls).toEqual([false])
  })

  it("stops listening once the keyboard closes", () => {
    keyboardState.open = true
    const { rerender } = renderHook(() => useKeyboardViewportPin(true))
    keyboardState.open = false
    rerender()
    scrollTo.mockClear()
    setScrollY(90)
    act(() => {
      window.dispatchEvent(new Event("scroll"))
    })
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it("undoes the scroll left behind when the keyboard closes", () => {
    jest.useFakeTimers()
    try {
      keyboardState.open = true
      const { rerender } = renderHook(() => useKeyboardViewportPin(true))
      scrollTo.mockClear()
      // Chromium re-applies the reveal scroll as the frame grows back.
      setScrollY(310)
      keyboardState.open = false
      rerender()
      expect(scrollTo).toHaveBeenCalledWith(0, 0)

      scrollTo.mockClear()
      setScrollY(0)
      act(() => {
        jest.advanceTimersByTime(32)
      })
      expect(scrollTo).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not reset on the close edge while pinch-zoomed", () => {
    keyboardState.open = true
    const { rerender } = renderHook(() => useKeyboardViewportPin(true))
    scrollTo.mockClear()
    vv.scale = 2
    setScrollY(200)
    keyboardState.open = false
    rerender()
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
