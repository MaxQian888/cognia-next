/**
 * Tests for useArtifactDockShortcuts.
 */

import { renderHook, act } from "@testing-library/react"
import { useArtifactDockShortcuts } from "./use-artifact-dock-shortcuts"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

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

describe("useArtifactDockShortcuts", () => {
  beforeEach(() => {
    window.localStorage.clear()
    useIsMobileMock.mockReturnValue(false)
    act(() => {
      useArtifactDockLayoutStore.getState().resetLayout()
    })
  })

  it("Cmd+J toggles the dock on desktop", () => {
    renderHook(() => useArtifactDockShortcuts())
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    act(() => pressMod("j"))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
    act(() => pressMod("j"))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("Ctrl+J works on non-Mac (no metaKey)", () => {
    renderHook(() => useArtifactDockShortcuts())
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true, cancelable: true })
      )
    })
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
  })

  it("ignores Cmd+Shift+J and Cmd+Alt+J", () => {
    renderHook(() => useArtifactDockShortcuts())
    act(() => {
      pressMod("j", { shiftKey: true })
      pressMod("j", { altKey: true })
    })
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("ignores plain J and other keys", () => {
    renderHook(() => useArtifactDockShortcuts())
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }))
      pressMod("k")
    })
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("bails when focus is inside .monaco-editor", () => {
    const monaco = document.createElement("div")
    monaco.className = "monaco-editor"
    const child = document.createElement("input")
    monaco.appendChild(child)
    document.body.appendChild(monaco)
    child.focus()
    try {
      renderHook(() => useArtifactDockShortcuts())
      act(() => pressMod("j"))
      expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    } finally {
      document.body.removeChild(monaco)
    }
  })

  it("on mobile: Cmd+J toggles the mobile Sheet instead of the collapsed flag", () => {
    useIsMobileMock.mockReturnValue(true)
    renderHook(() => useArtifactDockShortcuts())
    act(() => pressMod("j"))
    expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(true)
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    act(() => pressMod("j"))
    expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(false)
  })

  it("preventDefault only when matched", () => {
    renderHook(() => useArtifactDockShortcuts())
    let matched: Event | null = null
    let unmatched: Event | null = null
    act(() => {
      matched = pressMod("j")
      unmatched = pressMod("k")
    })
    expect(matched!.defaultPrevented).toBe(true)
    expect(unmatched!.defaultPrevented).toBe(false)
  })

  it("removes the listener on unmount", () => {
    const { unmount } = renderHook(() => useArtifactDockShortcuts())
    unmount()
    act(() => pressMod("j"))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })
})
