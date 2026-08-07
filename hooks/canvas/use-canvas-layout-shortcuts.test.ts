/**
 * Tests for useCanvasLayoutShortcuts — end-to-end through the shared dispatcher.
 */

import { renderHook, act } from "@testing-library/react"
import { useCanvasLayoutShortcuts } from "./use-canvas-layout-shortcuts"
import { useAppShortcutDispatcher } from "@/hooks/shortcuts/use-app-shortcut-dispatcher"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { getAppRegistration, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { __resetAppKeybindingStoreForTesting } from "@/stores/shortcuts/app-keybinding-store"
import {
  setContextKeys,
  __resetContextKeysForTesting,
} from "@/lib/plugin/context-keys/context-key-store"

jest.mock("@/hooks/ui", () => ({
  useIsMobile: jest.fn(() => false),
}))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchShortcut: jest.fn() }),
}))

import { useIsMobile } from "@/hooks/ui"

const useIsMobileMock = useIsMobile as jest.MockedFunction<typeof useIsMobile>

// The rail toggles carry `when: "view.canvas"`, so the Canvas guild must be active.
// Mount the dispatcher + the feature hook together (no JSX ⇒ .test.ts stays valid).
function mount() {
  return renderHook(() => {
    useAppShortcutDispatcher()
    useCanvasLayoutShortcuts()
  })
}

function pressMod(target: EventTarget, key: string, options: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  })
  target.dispatchEvent(event)
  return event
}

describe("useCanvasLayoutShortcuts", () => {
  beforeEach(() => {
    window.localStorage.clear()
    useIsMobileMock.mockReturnValue(false)
    __resetAppRuntimeForTesting()
    __resetAppKeybindingStoreForTesting()
    __resetContextKeysForTesting()
    setContextKeys({ "view.canvas": true })
    act(() => {
      useCanvasLayoutStore.getState().resetLayout()
    })
  })

  it("Cmd+B toggles the left rail on desktop", () => {
    mount()
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
    act(() => pressMod(document.body, "b"))
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(true)
    act(() => pressMod(document.body, "b"))
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
  })

  it("Cmd+J toggles the right rail on desktop", () => {
    mount()
    act(() => pressMod(document.body, "j"))
    expect(useCanvasLayoutStore.getState().rightCollapsed).toBe(true)
  })

  it("Ctrl+B works on non-Mac (no metaKey)", () => {
    mount()
    act(() => pressMod(document.body, "b", { metaKey: false, ctrlKey: true }))
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(true)
  })

  it("ignores Cmd+Shift+B and Cmd+Alt+B (modifier-noise)", () => {
    mount()
    act(() => {
      pressMod(document.body, "b", { shiftKey: true })
      pressMod(document.body, "b", { altKey: true })
    })
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
  })

  it("ignores plain B (no modifier) and keys outside b/j", () => {
    mount()
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }))
      pressMod(document.body, "k")
    })
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
    expect(useCanvasLayoutStore.getState().rightCollapsed).toBe(false)
  })

  it("does not fire when the Canvas guild is not active (when: view.canvas)", () => {
    __resetContextKeysForTesting() // view.canvas unset
    mount()
    act(() => pressMod(document.body, "b"))
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
  })

  it("bails when the event originates inside .monaco-editor", () => {
    const monaco = document.createElement("div")
    monaco.className = "monaco-editor"
    const child = document.createElement("span")
    monaco.appendChild(child)
    document.body.appendChild(monaco)
    try {
      mount()
      act(() => pressMod(child, "b"))
      expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
    } finally {
      document.body.removeChild(monaco)
    }
  })

  it("on mobile: Cmd+B toggles the left Sheet instead of the collapsed flag", () => {
    useIsMobileMock.mockReturnValue(true)
    mount()
    act(() => pressMod(document.body, "b"))
    expect(useCanvasLayoutStore.getState().mobileLeftOpen).toBe(true)
    expect(useCanvasLayoutStore.getState().leftCollapsed).toBe(false)
    act(() => pressMod(document.body, "b"))
    expect(useCanvasLayoutStore.getState().mobileLeftOpen).toBe(false)
  })

  it("on mobile: Cmd+J toggles the right Sheet", () => {
    useIsMobileMock.mockReturnValue(true)
    mount()
    act(() => pressMod(document.body, "j"))
    expect(useCanvasLayoutStore.getState().mobileRightOpen).toBe(true)
    expect(useCanvasLayoutStore.getState().rightCollapsed).toBe(false)
  })

  it("preventDefault is called only when matched", () => {
    mount()
    let matched: KeyboardEvent | null = null
    let unmatched: KeyboardEvent | null = null
    act(() => {
      matched = pressMod(document.body, "b")
      unmatched = pressMod(document.body, "k")
    })
    expect(matched!.defaultPrevented).toBe(true)
    expect(unmatched!.defaultPrevented).toBe(false)
  })

  it("removes its registrations on unmount", () => {
    const { unmount } = renderHook(() => useCanvasLayoutShortcuts())
    expect(getAppRegistration("canvasLayout.toggleLeft")).toBeDefined()
    expect(getAppRegistration("canvasLayout.toggleRight")).toBeDefined()
    unmount()
    expect(getAppRegistration("canvasLayout.toggleLeft")).toBeUndefined()
    expect(getAppRegistration("canvasLayout.toggleRight")).toBeUndefined()
  })
})
