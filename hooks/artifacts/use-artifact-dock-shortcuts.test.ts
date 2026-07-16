/**
 * Tests for useArtifactDockShortcuts — end-to-end through the shared dispatcher.
 */

import { renderHook, act } from "@testing-library/react"
import { useArtifactDockShortcuts } from "./use-artifact-dock-shortcuts"
import { useAppShortcutDispatcher } from "@/hooks/shortcuts/use-app-shortcut-dispatcher"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { getAppRegistration, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { __resetAppKeybindingStoreForTesting } from "@/stores/shortcuts/app-keybinding-store"
import { __resetContextKeysForTesting } from "@/lib/plugin/context-keys/context-key-store"

jest.mock("@/hooks/ui", () => ({
  useBreakpoint: jest.fn(() => "desktop"),
}))
jest.mock("@/lib/plugin", () => ({
  getPluginEventHooks: () => ({
    dispatchShortcut: jest.fn(),
    dispatchArtifactOpen: jest.fn(),
    dispatchArtifactClose: jest.fn(),
    dispatchPanelOpen: jest.fn(),
    dispatchPanelClose: jest.fn(),
  }),
}))

import { useBreakpoint } from "@/hooks/ui"

const useBreakpointMock = useBreakpoint as jest.MockedFunction<typeof useBreakpoint>

// `!view.canvas` is true with no context keys set, so the dock shortcut is live.
// Mount the dispatcher + the feature hook together (no JSX ⇒ .test.ts stays valid).
function mount() {
  return renderHook(() => {
    useAppShortcutDispatcher()
    useArtifactDockShortcuts()
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

describe("useArtifactDockShortcuts", () => {
  beforeEach(() => {
    window.localStorage.clear()
    useBreakpointMock.mockReturnValue("desktop")
    __resetAppRuntimeForTesting()
    __resetAppKeybindingStoreForTesting()
    __resetContextKeysForTesting()
    act(() => {
      useArtifactDockLayoutStore.getState().resetLayout()
      useArtifactStore.setState({ panelOpen: false, panelView: "artifact" })
    })
  })

  it("Cmd+J toggles the dock on desktop", () => {
    mount()
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    act(() => pressMod(document.body, "j"))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
    act(() => pressMod(document.body, "j"))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("Ctrl+J works on non-Mac (no metaKey)", () => {
    mount()
    act(() => pressMod(document.body, "j", { metaKey: false, ctrlKey: true }))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
  })

  it("ignores Cmd+Shift+J and Cmd+Alt+J", () => {
    mount()
    act(() => {
      pressMod(document.body, "j", { shiftKey: true })
      pressMod(document.body, "j", { altKey: true })
    })
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("ignores plain J and other keys", () => {
    mount()
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }))
      pressMod(document.body, "k")
    })
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("bails when the event originates inside .monaco-editor", () => {
    const monaco = document.createElement("div")
    monaco.className = "monaco-editor"
    const child = document.createElement("span")
    monaco.appendChild(child)
    document.body.appendChild(monaco)
    try {
      mount()
      act(() => pressMod(child, "j"))
      expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    } finally {
      document.body.removeChild(monaco)
    }
  })

  it("on mobile: Cmd+J toggles the current Workspace Sheet", () => {
    useBreakpointMock.mockReturnValue("mobile")
    act(() => useArtifactDockLayoutStore.getState().setDockMode("workspace"))
    mount()
    act(() => pressMod(document.body, "j"))
    expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(true)
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    act(() => {
      useArtifactDockLayoutStore.setState({
        workspaceContext: {
          kind: "file",
          sessionId: "session-1",
          rootPath: "/repo",
          relPath: "src/a.ts",
        },
      })
    })
    act(() => pressMod(document.body, "j"))
    expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(false)
    expect(useArtifactDockLayoutStore.getState().workspaceContext).toBeNull()
  })

  it("on tablet: Cmd+J toggles the Workspace Sheet instead of the desktop dock", () => {
    useBreakpointMock.mockReturnValue("tablet")
    act(() => useArtifactDockLayoutStore.getState().setDockMode("workspace"))
    mount()

    act(() => pressMod(document.body, "j"))

    expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(true)
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("on narrow Artifact mode: Cmd+J opens and closes the Artifact Sheet", () => {
    useBreakpointMock.mockReturnValue("mobile")
    mount()

    act(() => pressMod(document.body, "j"))
    expect(useArtifactStore.getState().panelOpen).toBe(true)
    expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(false)

    act(() => pressMod(document.body, "j"))
    expect(useArtifactStore.getState().panelOpen).toBe(false)
  })

  it("preventDefault only when matched", () => {
    mount()
    let matched: KeyboardEvent | null = null
    let unmatched: KeyboardEvent | null = null
    act(() => {
      matched = pressMod(document.body, "j")
      unmatched = pressMod(document.body, "k")
    })
    expect(matched!.defaultPrevented).toBe(true)
    expect(unmatched!.defaultPrevented).toBe(false)
  })

  it("removes its registration on unmount", () => {
    const { unmount } = renderHook(() => useArtifactDockShortcuts())
    expect(getAppRegistration("artifacts.toggleDock")).toBeDefined()
    unmount()
    expect(getAppRegistration("artifacts.toggleDock")).toBeUndefined()
  })
})
