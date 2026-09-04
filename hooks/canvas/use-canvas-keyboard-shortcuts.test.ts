/**
 * Tests for useCanvasKeyboardShortcuts — the global window-level Canvas
 * keyboard handler. Covers the bug fix (Ctrl+S no longer triggers the AI
 * "simplify" action), the view/save/navigation dispatches, and the
 * fall-through cases that must NOT preventDefault so Monaco keeps its keys.
 */

import { renderHook } from "@testing-library/react"
import { useCanvasKeyboardShortcuts } from "./use-canvas-keyboard-shortcuts"

let boundActionResolver: (combo: string) => string | undefined = () => undefined

jest.mock("@/stores/canvas/keybinding-store", () => ({
  useKeybindingStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ getActionByKeybinding: (combo: string) => boundActionResolver(combo) }),
  parseKeyEvent: (event: KeyboardEvent) => {
    const parts: string[] = []
    if (event.ctrlKey || event.metaKey) parts.push("Ctrl")
    if (event.altKey) parts.push("Alt")
    if (event.shiftKey) parts.push("Shift")
    const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
    if (!["Control", "Alt", "Shift", "Meta"].includes(key)) parts.push(key)
    return parts.join("+")
  },
}))

const layoutState = {
  rightCollapsed: false,
  activeRightTab: "suggestions",
  setRightCollapsed: jest.fn(),
  setActiveRightTab: jest.fn(),
}
jest.mock("@/stores/canvas/canvas-layout-store", () => ({
  useCanvasLayoutStore: { getState: () => layoutState },
}))

const artifactState = {
  canvasDocuments: {
    a: { id: "a" },
    b: { id: "b" },
    c: { id: "c" },
  },
  activeCanvasId: "a",
  setActiveCanvas: jest.fn(),
  // Document cycling reads the workspace-scoped list, not the raw map, so a
  // hotkey can never step into another workspace's document.
  getCanvasDocumentsForWorkspace: () => Object.values(artifactState.canvasDocuments),
}
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: { getState: () => artifactState },
}))

jest.mock("@/lib/canvas/constants", () => ({
  CANVAS_ACTIONS: [
    { type: "review", labelKey: "actionReview", icon: "eye" },
    { type: "simplify", labelKey: "actionSimplify", icon: "minimize" },
  ],
}))

const defaultOptions = { isActive: true, isProcessing: false, hasActiveDocument: true }

function press(init: KeyboardEventInit): { event: KeyboardEvent; prevented: boolean } {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return { event, prevented: event.defaultPrevented }
}

function dispatchedTypes(spy: jest.SpyInstance): string[] {
  return spy.mock.calls
    .map(([e]) => e)
    .filter((e): e is CustomEvent => e instanceof CustomEvent)
    .map((e) => e.type)
}

describe("useCanvasKeyboardShortcuts", () => {
  let dispatchSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    boundActionResolver = () => undefined
    layoutState.rightCollapsed = false
    layoutState.activeRightTab = "suggestions"
    artifactState.activeCanvasId = "a"
    dispatchSpy = jest.spyOn(window, "dispatchEvent")
  })

  afterEach(() => dispatchSpy.mockRestore())

  it("attaches/detaches the keydown listener with the active gate", () => {
    const addSpy = jest.spyOn(window, "addEventListener")
    const { unmount } = renderHook(() =>
      useCanvasKeyboardShortcuts({ ...defaultOptions, isActive: false })
    )
    expect(addSpy.mock.calls.filter(([e]) => String(e) === "keydown")).toHaveLength(0)
    unmount()

    const removeSpy = jest.spyOn(window, "removeEventListener")
    const active = renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    expect(addSpy.mock.calls.filter(([e]) => String(e) === "keydown")).toHaveLength(1)
    active.unmount()
    expect(removeSpy.mock.calls.filter(([e]) => String(e) === "keydown")).toHaveLength(1)
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it("does NOT trigger the AI simplify action on Ctrl+S (regression: key hijack bug)", () => {
    // Ctrl+S is bound to canvas.save; the old fallback map turned it into simplify.
    boundActionResolver = (c) => (c === "Ctrl+S" ? "canvas.save" : undefined)
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))

    const { prevented } = press({ key: "s", ctrlKey: true })

    const types = dispatchedTypes(dispatchSpy)
    expect(types).toContain("canvas-save")
    expect(types).not.toContain("canvas-action")
    expect(prevented).toBe(true)
  })

  it("dispatches canvas-save with the correct mode for save vs saveVersion", () => {
    boundActionResolver = (c) => (c === "Ctrl+Shift+S" ? "canvas.saveVersion" : undefined)
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    press({ key: "S", ctrlKey: true, shiftKey: true })
    const saveEvent = dispatchSpy.mock.calls
      .map(([e]) => e)
      .find((e): e is CustomEvent => e instanceof CustomEvent && e.type === "canvas-save")
    expect((saveEvent?.detail as { mode: string }).mode).toBe("version")
  })

  it("dispatches canvas-action for an action.* binding", () => {
    boundActionResolver = (c) => (c === "Ctrl+Shift+R" ? "action.review" : undefined)
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    press({ key: "R", ctrlKey: true, shiftKey: true })
    const actionEvent = dispatchSpy.mock.calls
      .map(([e]) => e)
      .find((e): e is CustomEvent => e instanceof CustomEvent && e.type === "canvas-action")
    expect((actionEvent?.detail as { type: string }).type).toBe("review")
  })

  it("suppresses action.* dispatch while processing but still allows save", () => {
    boundActionResolver = (c) =>
      c === "Ctrl+Shift+R" ? "action.review" : c === "Ctrl+S" ? "canvas.save" : undefined
    renderHook(() => useCanvasKeyboardShortcuts({ ...defaultOptions, isProcessing: true }))
    press({ key: "R", ctrlKey: true, shiftKey: true })
    expect(dispatchedTypes(dispatchSpy)).not.toContain("canvas-action")
    press({ key: "s", ctrlKey: true })
    expect(dispatchedTypes(dispatchSpy)).toContain("canvas-save")
  })

  it("opens the command palette on view.toggleInlineCommand", () => {
    boundActionResolver = (c) => (c === "Ctrl+K" ? "view.toggleInlineCommand" : undefined)
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    press({ key: "k", ctrlKey: true })
    expect(dispatchedTypes(dispatchSpy)).toContain("canvas-inline-command")
  })

  it("switches the right rail tab on view.toggleHistory", () => {
    boundActionResolver = (c) => (c === "Ctrl+Shift+H" ? "view.toggleHistory" : undefined)
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    press({ key: "H", ctrlKey: true, shiftKey: true })
    expect(layoutState.setActiveRightTab).toHaveBeenCalledWith("history")
  })

  it("collapses the rail when toggling the already-active tab", () => {
    layoutState.activeRightTab = "suggestions"
    boundActionResolver = (c) => (c === "Ctrl+." ? "view.toggleSuggestions" : undefined)
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    press({ key: ".", ctrlKey: true })
    expect(layoutState.setRightCollapsed).toHaveBeenCalledWith(true)
  })

  it("expands a collapsed rail onto the requested tab", () => {
    layoutState.rightCollapsed = true
    boundActionResolver = (c) => (c === "Ctrl+`" ? "view.toggleExecution" : undefined)
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    press({ key: "`", ctrlKey: true })
    expect(layoutState.setRightCollapsed).toHaveBeenCalledWith(false)
    expect(layoutState.setActiveRightTab).toHaveBeenCalledWith("execution")
  })

  it("cycles the active document on navigation.nextDocument", () => {
    boundActionResolver = (c) => (c === "Ctrl+Tab" ? "navigation.nextDocument" : undefined)
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    press({ key: "Tab", ctrlKey: true })
    expect(artifactState.setActiveCanvas).toHaveBeenCalledWith("b")
  })

  it("wraps to the last document on navigation.prevDocument from the first", () => {
    artifactState.activeCanvasId = "a"
    boundActionResolver = (c) => (c === "Ctrl+Shift+Tab" ? "navigation.prevDocument" : undefined)
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    press({ key: "Tab", ctrlKey: true, shiftKey: true })
    expect(artifactState.setActiveCanvas).toHaveBeenCalledWith("c")
  })

  it("falls through (no preventDefault) for editor-scoped bindings handled by Monaco", () => {
    boundActionResolver = (c) => (c === "Ctrl+F" ? "canvas.find" : undefined)
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    const { prevented } = press({ key: "f", ctrlKey: true })
    expect(prevented).toBe(false)
    expect(dispatchedTypes(dispatchSpy)).not.toContain("canvas-action")
  })

  it("ignores unbound key combos", () => {
    renderHook(() => useCanvasKeyboardShortcuts(defaultOptions))
    const { prevented } = press({ key: "z", ctrlKey: true })
    expect(prevented).toBe(false)
  })
})
