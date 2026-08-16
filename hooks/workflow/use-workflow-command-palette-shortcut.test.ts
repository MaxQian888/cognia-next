/**
 * Tests for useWorkflowCommandPaletteShortcut — driven end-to-end through the
 * shared dispatcher, because the whole point of the hook is that the *one*
 * dispatcher decides between this palette and the global search.
 */

import { renderHook, act } from "@testing-library/react"

import { useAppShortcutDispatcher } from "@/hooks/shortcuts/use-app-shortcut-dispatcher"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { getAppRegistration, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import {
  getContextKeySnapshot,
  __resetContextKeysForTesting,
} from "@/lib/plugin/context-keys/context-key-store"
import { __resetAppKeybindingStoreForTesting } from "@/stores/shortcuts/app-keybinding-store"

import {
  useWorkflowCommandPaletteShortcut,
  WORKFLOW_EDITOR_CONTEXT_KEY,
} from "./use-workflow-command-palette-shortcut"

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchShortcut: jest.fn() }),
}))

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

describe("useWorkflowCommandPaletteShortcut", () => {
  beforeEach(() => {
    window.localStorage.clear()
    __resetAppRuntimeForTesting()
    __resetAppKeybindingStoreForTesting()
    __resetContextKeysForTesting()
  })

  it("publishes view.workflowEditor while mounted and clears it on unmount", () => {
    const { unmount } = renderHook(() => useWorkflowCommandPaletteShortcut(jest.fn()))
    expect(getContextKeySnapshot()[WORKFLOW_EDITOR_CONTEXT_KEY]).toBe(true)
    unmount()
    expect(getContextKeySnapshot()[WORKFLOW_EDITOR_CONTEXT_KEY]).toBe(false)
  })

  it("Cmd+K toggles the editor palette", () => {
    const toggle = jest.fn()
    renderHook(() => {
      useAppShortcutDispatcher()
      useWorkflowCommandPaletteShortcut(toggle)
    })
    act(() => {
      pressMod(document.body, "k")
    })
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it("Ctrl+K works on non-Mac (no metaKey)", () => {
    const toggle = jest.fn()
    renderHook(() => {
      useAppShortcutDispatcher()
      useWorkflowCommandPaletteShortcut(toggle)
    })
    act(() => {
      pressMod(document.body, "k", { metaKey: false, ctrlKey: true })
    })
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it("fires from inside an inspector field (allowInEditable)", () => {
    const toggle = jest.fn()
    const input = document.createElement("input")
    document.body.appendChild(input)
    try {
      renderHook(() => {
        useAppShortcutDispatcher()
        useWorkflowCommandPaletteShortcut(toggle)
      })
      act(() => {
        pressMod(input, "k")
      })
      expect(toggle).toHaveBeenCalledTimes(1)
    } finally {
      document.body.removeChild(input)
    }
  })

  it("preventDefaults the matched chord but not a neighbouring one", () => {
    renderHook(() => {
      useAppShortcutDispatcher()
      useWorkflowCommandPaletteShortcut(jest.fn())
    })
    let matched: KeyboardEvent | null = null
    let unmatched: KeyboardEvent | null = null
    act(() => {
      matched = pressMod(document.body, "k")
      unmatched = pressMod(document.body, "l")
    })
    expect(matched!.defaultPrevented).toBe(true)
    expect(unmatched!.defaultPrevented).toBe(false)
  })

  it("removes its registration on unmount", () => {
    const { unmount } = renderHook(() => useWorkflowCommandPaletteShortcut(jest.fn()))
    expect(getAppRegistration("workflow.commandPalette.toggle")).toBeDefined()
    unmount()
    expect(getAppRegistration("workflow.commandPalette.toggle")).toBeUndefined()
  })

  // The regression this hook exists for: before it, `canvas.tsx` owned a raw
  // `window` keydown listener that ran *alongside* the dispatcher's, so one ⌘K
  // opened the editor palette and the global search dialog at once.
  describe("against the global search on the same chord", () => {
    function mountBoth(globalToggle: () => void, workflowToggle: () => void) {
      return renderHook(() => {
        useAppShortcutDispatcher()
        // Mirrors GlobalSearchDialog, which registers first (shell-level mount)
        // and inherits `when: "!view.workflowEditor"` from the catalog.
        useAppShortcut("app.commandPalette.toggle", globalToggle, {
          allowInEditable: true,
          preventDefault: true,
        })
        useWorkflowCommandPaletteShortcut(workflowToggle)
      })
    }

    it("Cmd+K opens only the editor palette while the editor is mounted", () => {
      const globalToggle = jest.fn()
      const workflowToggle = jest.fn()
      mountBoth(globalToggle, workflowToggle)
      act(() => {
        pressMod(document.body, "k")
      })
      expect(workflowToggle).toHaveBeenCalledTimes(1)
      expect(globalToggle).not.toHaveBeenCalled()
    })

    it("hands Cmd+K back to the global search once the editor unmounts", () => {
      const globalToggle = jest.fn()
      const workflowToggle = jest.fn()
      const { unmount } = mountBoth(globalToggle, workflowToggle)
      unmount()

      const afterGlobal = jest.fn()
      renderHook(() => {
        useAppShortcutDispatcher()
        useAppShortcut("app.commandPalette.toggle", afterGlobal, {
          allowInEditable: true,
          preventDefault: true,
        })
      })
      act(() => {
        pressMod(document.body, "k")
      })
      expect(afterGlobal).toHaveBeenCalledTimes(1)
      expect(workflowToggle).not.toHaveBeenCalled()
    })
  })
})
