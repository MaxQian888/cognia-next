"use client"

/**
 * useCanvasKeyboardShortcuts — the global (window-level) half of Canvas
 * keyboard handling. It owns only the bindings that must work regardless of
 * which element is focused and that don't collide with the editor's own keys:
 *
 *  - `action.*`            → dispatch the `canvas-action` CustomEvent the toolbar listens for
 *  - `view.toggleInlineCommand` → open the Ctrl+K command palette (`canvas-inline-command`)
 *  - `view.toggle{History,Suggestions,Execution}` → switch/collapse the right rail tab
 *  - `canvas.save` / `canvas.saveVersion` → dispatch `canvas-save` (panel owns the editor buffer)
 *  - `navigation.next/prevDocument` → cycle the active document
 *
 * Everything else is handled where it belongs by focus context, NOT here:
 *  - `canvas.find/replace/goToLine/format`, `canvas.toggle{WordWrap,Minimap}`,
 *    `edit.duplicate/comment`, `fold.*` → registered as Monaco actions
 *    (`register-canvas-editor-actions.ts`), so they only fire when the editor is focused.
 *  - `navigation.*Suggestion` → the suggestions panel handles them when focused.
 *
 * This replaces the previous implementation whose `DEFAULT_KEY_ACTION_MAP`
 * fallback hijacked Ctrl+S→simplify, Ctrl+X→expand, Ctrl+F→fix, etc. — a real
 * bug that broke save / cut / find inside the canvas.
 */

import { useEffect } from "react"
import { useKeybindingStore, parseKeyEvent } from "@/stores/canvas/keybinding-store"
import { useCanvasLayoutStore, type CanvasRightTab } from "@/stores/canvas/canvas-layout-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { CanvasDocument } from "@/types/artifact/artifact"
import { CANVAS_ACTIONS } from "@/lib/canvas/constants"

export interface UseCanvasKeyboardShortcutsOptions {
  isActive: boolean
  isProcessing: boolean
  hasActiveDocument: boolean
}

const VIEW_TAB_BY_ACTION: Record<string, CanvasRightTab> = {
  "view.toggleHistory": "history",
  "view.toggleSuggestions": "suggestions",
  "view.toggleExecution": "execution",
}

/** Switch the right rail to `tab`; if it's already the active + visible tab, collapse the rail. */
function toggleRightTab(tab: CanvasRightTab): void {
  const layout = useCanvasLayoutStore.getState()
  if (layout.rightCollapsed) {
    layout.setRightCollapsed(false)
    layout.setActiveRightTab(tab)
  } else if (layout.activeRightTab === tab) {
    layout.setRightCollapsed(true)
  } else {
    layout.setActiveRightTab(tab)
  }
}

/** Move the active canvas document by `dir` (+1 next / -1 previous), wrapping around. */
function cycleDocument(dir: 1 | -1): void {
  const store = useArtifactStore.getState()
  const docs = Object.values(store.canvasDocuments) as CanvasDocument[]
  if (docs.length < 2) return
  const currentIndex = docs.findIndex((d) => d.id === store.activeCanvasId)
  const base = currentIndex === -1 ? 0 : currentIndex
  const next = docs[(base + dir + docs.length) % docs.length]
  if (next) store.setActiveCanvas(next.id)
}

export function useCanvasKeyboardShortcuts({
  isActive,
  isProcessing,
  hasActiveDocument,
}: UseCanvasKeyboardShortcutsOptions): void {
  const getActionByKeybinding = useKeybindingStore((state) => state.getActionByKeybinding)

  useEffect(() => {
    if (!isActive || !hasActiveDocument) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const keyCombo = parseKeyEvent(e)
      const boundAction = getActionByKeybinding(keyCombo)
      if (!boundAction) return

      if (boundAction.startsWith("action.")) {
        if (isProcessing) return
        const actionType = boundAction.replace("action.", "")
        const action = CANVAS_ACTIONS.find((a) => a.type === actionType)
        if (!action) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent("canvas-action", { detail: action }))
        return
      }

      if (boundAction === "view.toggleInlineCommand") {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent("canvas-inline-command"))
        return
      }

      const viewTab = VIEW_TAB_BY_ACTION[boundAction]
      if (viewTab) {
        e.preventDefault()
        toggleRightTab(viewTab)
        return
      }

      if (boundAction === "canvas.save" || boundAction === "canvas.saveVersion") {
        e.preventDefault()
        window.dispatchEvent(
          new CustomEvent("canvas-save", {
            detail: { mode: boundAction === "canvas.saveVersion" ? "version" : "manual" },
          })
        )
        return
      }

      if (boundAction === "navigation.nextDocument") {
        e.preventDefault()
        cycleDocument(1)
        return
      }
      if (boundAction === "navigation.prevDocument") {
        e.preventDefault()
        cycleDocument(-1)
        return
      }

      // canvas.find/replace/goToLine/format, canvas.toggle*, edit.*, fold.*,
      // navigation.*Suggestion — handled by Monaco / the suggestions panel.
      // Fall through without preventDefault so those handlers receive the key.
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isActive, isProcessing, hasActiveDocument, getActionByKeybinding])
}

export default useCanvasKeyboardShortcuts
