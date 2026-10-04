/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import {
  KEYBOARD_DOCK_DURATION_MS,
  KEYBOARD_DOCK_EASING,
  readTranslateY,
  useKeyboardDockMotion,
} from "./use-keyboard-dock-motion"

jest.mock("@cognia/plugin-ui/motion-tokens", () => ({
  ...jest.requireActual("@cognia/plugin-ui/motion-tokens"),
  readReducedMotion: jest.fn(() => false),
}))

import { readReducedMotion } from "@cognia/plugin-ui/motion-tokens"

const mockReduced = readReducedMotion as jest.Mock

// ResizeObserver: capture the callback so a test can fire "layout changed".
let resizeCallback: (() => void) | null = null
const observed: Element[] = []
const disconnect = jest.fn()
class FakeResizeObserver {
  constructor(cb: () => void) {
    resizeCallback = cb
  }
  observe(el: Element) {
    observed.push(el)
  }
  disconnect() {
    disconnect()
  }
}

function makeDock() {
  const parent = document.createElement("div")
  const dock = document.createElement("div")
  parent.appendChild(dock)
  document.body.appendChild(parent)
  let bottom = 800
  let transform = "none"
  dock.getBoundingClientRect = () => {
    const ty = readTranslateY(dock)
    return { top: bottom - 150 + ty, bottom: bottom + ty } as DOMRect
  }
  const animate = jest.fn(() => {
    const anim = { cancel: jest.fn(), onfinish: null as null | (() => void) }
    return anim as unknown as Animation
  })
  ;(dock as unknown as { animate: typeof animate }).animate = animate
  const realGetComputedStyle = window.getComputedStyle
  jest.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
    if (el === dock) {
      return { transform, getPropertyValue: () => "" } as unknown as CSSStyleDeclaration
    }
    return realGetComputedStyle(el)
  })
  return {
    dock,
    parent,
    animate,
    moveBottom(next: number) {
      bottom = next
    },
    setTransform(value: string) {
      transform = value
    },
  }
}

beforeEach(() => {
  resizeCallback = null
  observed.length = 0
  disconnect.mockReset()
  mockReduced.mockReset().mockReturnValue(false)
  ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
})

afterEach(() => {
  jest.restoreAllMocks()
  document.body.innerHTML = ""
})

describe("readTranslateY", () => {
  it("reads ty from 2D and 3D matrices and 0 otherwise", () => {
    const el = document.createElement("div")
    const spy = jest.spyOn(window, "getComputedStyle")
    spy.mockReturnValue({ transform: "matrix(1, 0, 0, 1, 0, 42.5)" } as CSSStyleDeclaration)
    expect(readTranslateY(el)).toBe(42.5)
    spy.mockReturnValue({
      transform: "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -12, 0, 1)",
    } as CSSStyleDeclaration)
    expect(readTranslateY(el)).toBe(-12)
    spy.mockReturnValue({ transform: "none" } as CSSStyleDeclaration)
    expect(readTranslateY(el)).toBe(0)
    spy.mockReturnValue({ transform: "rotate(3deg)" } as CSSStyleDeclaration)
    expect(readTranslateY(el)).toBe(0)
  })
})

describe("useKeyboardDockMotion", () => {
  it("observes the dock and its parent column", () => {
    const { dock, parent } = makeDock()
    renderHook(() => useKeyboardDockMotion(dock, true))
    expect(observed).toEqual([dock, parent])
  })

  it("glides from the old on-screen position when the dock's bottom moves", () => {
    const { dock, animate, moveBottom } = makeDock()
    renderHook(() => useKeyboardDockMotion(dock, true))

    // The keyboard opened: the column now ends 320px higher.
    moveBottom(480)
    act(() => resizeCallback?.())
    expect(animate).toHaveBeenCalledWith(
      [{ transform: "translateY(320px)" }, { transform: "translateY(0px)" }],
      { duration: KEYBOARD_DOCK_DURATION_MS, easing: KEYBOARD_DOCK_EASING }
    )
  })

  it("composes a move that lands mid-glide with where the dock is on screen", () => {
    const { dock, animate, moveBottom, setTransform } = makeDock()
    renderHook(() => useKeyboardDockMotion(dock, true))

    moveBottom(856) // tab-bar reserve collapsed: the dock dropped 56px
    act(() => resizeCallback?.())
    expect(animate).toHaveBeenLastCalledWith(
      [{ transform: "translateY(-56px)" }, expect.anything()],
      expect.anything()
    )
    const first = animate.mock.results[0].value as { cancel: jest.Mock }

    // Half-way through that glide the WebView shrinks by 320px.
    setTransform("matrix(1, 0, 0, 1, 0, -20)")
    moveBottom(536)
    act(() => resizeCallback?.())
    expect(first.cancel).toHaveBeenCalled()
    // Layout bottom went 856 → 536 (-320); the dock showed at -20 → start +300.
    expect(animate).toHaveBeenLastCalledWith(
      [{ transform: "translateY(300px)" }, { transform: "translateY(0px)" }],
      expect.anything()
    )
  })

  it("ignores changes that leave the bottom where it was (content growing)", () => {
    const { dock, animate } = makeDock()
    renderHook(() => useKeyboardDockMotion(dock, true))
    act(() => resizeCallback?.())
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(animate).not.toHaveBeenCalled()
  })

  it("reacts to window resize (the WebView frame resizing)", () => {
    const { dock, animate, moveBottom } = makeDock()
    renderHook(() => useKeyboardDockMotion(dock, true))
    moveBottom(500)
    act(() => {
      window.dispatchEvent(new Event("resize"))
    })
    expect(animate).toHaveBeenCalledTimes(1)
  })

  it("snaps instead of gliding under reduced motion", () => {
    mockReduced.mockReturnValue(true)
    const { dock, animate, moveBottom } = makeDock()
    renderHook(() => useKeyboardDockMotion(dock, true))
    moveBottom(480)
    act(() => resizeCallback?.())
    expect(animate).not.toHaveBeenCalled()
  })

  it("stretches the glide with the app's motion-speed multiplier", () => {
    const { dock, animate, moveBottom } = makeDock()
    const style = window.getComputedStyle as unknown as jest.Mock
    const base = style.getMockImplementation() as (el: Element) => CSSStyleDeclaration
    style.mockImplementation((el: Element) =>
      el === dock
        ? ({
            transform: "none",
            getPropertyValue: (name: string) => (name === "--motion-duration-scale" ? "2" : ""),
          } as unknown as CSSStyleDeclaration)
        : base(el)
    )
    renderHook(() => useKeyboardDockMotion(dock, true))
    moveBottom(480)
    act(() => resizeCallback?.())
    expect(animate).toHaveBeenCalledWith(expect.anything(), {
      duration: KEYBOARD_DOCK_DURATION_MS * 2,
      easing: KEYBOARD_DOCK_EASING,
    })
  })

  it("does nothing when disabled or without an element", () => {
    const { dock, animate } = makeDock()
    renderHook(() => useKeyboardDockMotion(dock, false))
    renderHook(() => useKeyboardDockMotion(null, true))
    expect(observed).toEqual([])
    expect(animate).not.toHaveBeenCalled()
  })

  it("disconnects and cancels the glide on unmount", () => {
    const { dock, animate, moveBottom } = makeDock()
    const { unmount } = renderHook(() => useKeyboardDockMotion(dock, true))
    moveBottom(480)
    act(() => resizeCallback?.())
    const glide = animate.mock.results[0].value as { cancel: jest.Mock }
    unmount()
    expect(disconnect).toHaveBeenCalled()
    expect(glide.cancel).toHaveBeenCalled()
  })
})
