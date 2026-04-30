/**
 * Tests for useCanvasKeyboardShortcuts hook
 */

import { renderHook } from "@testing-library/react"
import { useCanvasKeyboardShortcuts } from "./use-canvas-keyboard-shortcuts"

// Mock keybinding store
jest.mock("@/stores/canvas/keybinding-store", () => ({
  useKeybindingStore: jest.fn((selector) =>
    selector({
      getActionByKeybinding: jest.fn(() => undefined),
    })
  ),
  parseKeyEvent: (event: KeyboardEvent) => {
    const parts: string[] = []
    if (event.ctrlKey || event.metaKey) parts.push("Ctrl")
    if (event.altKey) parts.push("Alt")
    if (event.shiftKey) parts.push("Shift")
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
    if (!["Control", "Alt", "Shift", "Meta"].includes(key)) {
      parts.push(key)
    }
    return parts.join("+")
  },
}))

// Mock constants
jest.mock("@/lib/canvas/constants", () => ({
  CANVAS_ACTIONS: [
    { type: "review", labelKey: "actionReview", icon: "eye" },
    { type: "fix", labelKey: "actionFix", icon: "bug" },
    { type: "improve", labelKey: "actionImprove", icon: "sparkles" },
    { type: "explain", labelKey: "actionExplain", icon: "help" },
    { type: "simplify", labelKey: "actionSimplify", icon: "minimize" },
    { type: "expand", labelKey: "actionExpand", icon: "maximize" },
  ],
  DEFAULT_KEY_ACTION_MAP: {
    r: "review",
    f: "fix",
    i: "improve",
    e: "explain",
    s: "simplify",
    x: "expand",
  },
}))

describe("useCanvasKeyboardShortcuts", () => {
  let dispatchEventSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    dispatchEventSpy = jest.spyOn(window, "dispatchEvent")
  })

  afterEach(() => {
    dispatchEventSpy.mockRestore()
  })

  const defaultOptions = {
    isActive: true,
    isProcessing: false,
    hasActiveDocument: true,
  }

  it("should not add listener when not active", () => {
    const addSpy = jest.spyOn(window, "addEventListener")
    renderHook(() => useCanvasKeyboardShortcuts({ ...defaultOptions, isActive: false }))
    const keydownCalls = addSpy.mock.calls.filter(([event]) => String(event) === "keydown")
    expect(keydownCalls.length).toBe(0)
    addSpy.mockRestore()
  })

  it("should not add listener when no active document", () => {
    const addSpy = jest.spyOn(window, "addEventListener")
    renderHook(() => useCanvasKeyboardShortcuts({ ...defaultOptions, hasActiveDocument: false }))
    const keydownCalls = addSpy.mock.calls.filter(([event]) => String(event) === "keydown")
    expect(keydownCalls.length).toBe(0)
    addSpy.mockRestore()
  })

  it("should add keydown listener when active with document", () => {
    const addSpy = jest.spyOn(window, "addEventListener")
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    const keydownCalls = addSpy.mock.calls.filter(([event]) => String(event) === "keydown")
    expect(keydownCalls.length).toBe(1)
    addSpy.mockRestore()
  })

  it("should remove keydown listener on unmount", () => {
    const removeSpy = jest.spyOn(window, "removeEventListener")
    const { unmount } = renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    unmount()
    const keydownCalls = removeSpy.mock.calls.filter(([event]) => String(event) === "keydown")
    expect(keydownCalls.length).toBe(1)
    removeSpy.mockRestore()
  })

  it("should dispatch canvas-action for Ctrl+R (review via default map)", () => {
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))

    const event = new KeyboardEvent("keydown", {
      key: "r",
      ctrlKey: true,
      bubbles: true,
    })
    const preventDefaultSpy = jest.spyOn(event, "preventDefault")
    window.dispatchEvent(event)

    // Should have dispatched a canvas-action CustomEvent
    const canvasActionCalls = dispatchEventSpy.mock.calls.filter(
      ([e]) => e instanceof CustomEvent && e.type === "canvas-action"
    )
    expect(canvasActionCalls.length).toBe(1)
    expect(canvasActionCalls[0][0].detail.type).toBe("review")
    expect(preventDefaultSpy).toHaveBeenCalled()
  })

  it("should dispatch canvas-action for Ctrl+F (fix via default map)", () => {
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))

    const event = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
    })
    window.dispatchEvent(event)

    const canvasActionCalls = dispatchEventSpy.mock.calls.filter(
      ([e]) => e instanceof CustomEvent && e.type === "canvas-action"
    )
    expect(canvasActionCalls.length).toBe(1)
    expect(canvasActionCalls[0][0].detail.type).toBe("fix")
  })

  it("should not dispatch when isProcessing is true", () => {
    renderHook(() => useCanvasKeyboardShortcuts({ ...defaultOptions, isProcessing: true }))

    const event = new KeyboardEvent("keydown", {
      key: "r",
      ctrlKey: true,
      bubbles: true,
    })
    window.dispatchEvent(event)

    const canvasActionCalls = dispatchEventSpy.mock.calls.filter(
      ([e]) => e instanceof CustomEvent && e.type === "canvas-action"
    )
    expect(canvasActionCalls.length).toBe(0)
  })

  it("should not dispatch for key without Ctrl/Meta modifier", () => {
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))

    const event = new KeyboardEvent("keydown", {
      key: "r",
      ctrlKey: false,
      bubbles: true,
    })
    window.dispatchEvent(event)

    const canvasActionCalls = dispatchEventSpy.mock.calls.filter(
      ([e]) => e instanceof CustomEvent && e.type === "canvas-action"
    )
    expect(canvasActionCalls.length).toBe(0)
  })

  it("should not dispatch for unmapped keys", () => {
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))

    const event = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
    })
    window.dispatchEvent(event)

    const canvasActionCalls = dispatchEventSpy.mock.calls.filter(
      ([e]) => e instanceof CustomEvent && e.type === "canvas-action"
    )
    expect(canvasActionCalls.length).toBe(0)
  })

  it("should use keybinding store when bound action exists", () => {
    const { useKeybindingStore } = jest.requireMock("@/stores/canvas/keybinding-store")
    useKeybindingStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        getActionByKeybinding: (keyCombo: string) => {
          if (keyCombo === "Ctrl+Shift+R") return "action.review"
          return undefined
        },
      })
    )

    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))

    const event = new KeyboardEvent("keydown", {
      key: "R",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    })
    window.dispatchEvent(event)

    const canvasActionCalls = dispatchEventSpy.mock.calls.filter(
      ([e]) => e instanceof CustomEvent && e.type === "canvas-action"
    )
    expect(canvasActionCalls.length).toBe(1)
    expect(canvasActionCalls[0][0].detail.type).toBe("review")

    // Restore
    useKeybindingStore.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        getActionByKeybinding: jest.fn(() => undefined),
      })
    )
  })
})
