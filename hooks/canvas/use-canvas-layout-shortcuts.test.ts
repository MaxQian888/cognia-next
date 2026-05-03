/**
 * Tests for useCanvasLayoutShortcuts.
 */

import { renderHook, act } from "@testing-library/react"
import { useCanvasLayoutShortcuts } from "./use-canvas-layout-shortcuts"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"

jest.mock("@/hooks/ui", () => ({
  useIsMobile: jest.fn(() => false),
}))

import { useIsMobile } from "@/hooks/ui"

const useIsMobileMock = useIsMobile as jest.MockedFunction<typeof useIsMobile>

function pressMod(key: string, options: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  })
  window.dispatchEvent(event)
  return event
}

describe("useCanvasLayoutShortcuts", () => {
  beforeEach(() => {
    window.localStorage.clear()
    useIsMobileMock.mockReturnValue(false)
    act(() => {
      useCanvasLayoutStore.getState().resetLayout()
    })
  })

  it("Cmd+B toggles the left rail on desktop", () => {
    renderHook(() => useCanvasLayoutShortcuts())
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
    act(() => {
      pressMod("b")
    })
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(true)
    act(() => {
      pressMod("b")
    })
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
  })

  it("Cmd+J toggles the right rail on desktop", () => {
    renderHook(() => useCanvasLayoutShortcuts())
    act(() => {
      pressMod("j")
    })
    expect(useCanvasLayoutStore.getState().rightCollapsed).toBe(true)
  })

  it("Ctrl+B works on non-Mac (no metaKey)", () => {
    renderHook(() => useCanvasLayoutShortcuts())
    act(() => {
      const event = new KeyboardEvent("keydown", {
        key: "b",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      window.dispatchEvent(event)
    })
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(true)
  })

  it("ignores Cmd+Shift+B and Cmd+Alt+B (modifier-noise)", () => {
    renderHook(() => useCanvasLayoutShortcuts())
    act(() => {
      pressMod("b", { shiftKey: true })
      pressMod("b", { altKey: true })
    })
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
  })

  it("ignores plain B (no modifier)", () => {
    renderHook(() => useCanvasLayoutShortcuts())
    act(() => {
      const event = new KeyboardEvent("keydown", {
        key: "b",
        bubbles: true,
        cancelable: true,
      })
      window.dispatchEvent(event)
    })
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
  })

  it("ignores keys outside b/j", () => {
    renderHook(() => useCanvasLayoutShortcuts())
    act(() => {
      pressMod("k")
    })
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
    expect(useCanvasLayoutStore.getState().rightCollapsed).toBe(false)
  })

  it("bails when focus is inside .monaco-editor", () => {
    const monaco = document.createElement("div")
    monaco.className = "monaco-editor"
    const child = document.createElement("input")
    monaco.appendChild(child)
    document.body.appendChild(monaco)
    child.focus()
    try {
      renderHook(() => useCanvasLayoutShortcuts())
      act(() => {
        pressMod("b")
      })
      expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
    } finally {
      document.body.removeChild(monaco)
    }
  })

  it("on mobile: Cmd+B toggles the left Sheet instead of the collapsed flag", () => {
    useIsMobileMock.mockReturnValue(true)
    renderHook(() => useCanvasLayoutShortcuts())
    act(() => {
      pressMod("b")
    })
    expect(useCanvasLayoutStore.getState().mobileLeftOpen).toBe(true)
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
    act(() => {
      pressMod("b")
    })
    expect(useCanvasLayoutStore.getState().mobileLeftOpen).toBe(false)
  })

  it("on mobile: Cmd+J toggles the right Sheet", () => {
    useIsMobileMock.mockReturnValue(true)
    renderHook(() => useCanvasLayoutShortcuts())
    act(() => {
      pressMod("j")
    })
    expect(useCanvasLayoutStore.getState().mobileRightOpen).toBe(true)
    expect(useCanvasLayoutStore.getState().rightCollapsed).toBe(false)
  })

  it("preventDefault is called only when matched", () => {
    renderHook(() => useCanvasLayoutShortcuts())
    let matched: Event | null = null
    let unmatched: Event | null = null
    act(() => {
      matched = pressMod("b")
      unmatched = pressMod("k")
    })
    expect(matched!.defaultPrevented).toBe(true)
    expect(unmatched!.defaultPrevented).toBe(false)
  })

  it("removes the listener on unmount", () => {
    const { unmount } = renderHook(() => useCanvasLayoutShortcuts())
    unmount()
    act(() => {
      pressMod("b")
    })
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
  })
})
