"use client"

/**
 * useCanvasKeyboardShortcuts - Handles keyboard shortcut dispatching for Canvas actions
 */

import { useEffect } from "react"
import { useKeybindingStore, parseKeyEvent } from "@/stores/canvas/keybinding-store"
import { CANVAS_ACTIONS, DEFAULT_KEY_ACTION_MAP } from "@/lib/canvas/constants"

export interface UseCanvasKeyboardShortcutsOptions {
  isActive: boolean
  isProcessing: boolean
  hasActiveDocument: boolean
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
      // Check for Cmd/Ctrl key
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod || isProcessing) return

      const keyCombo = parseKeyEvent(e)

      // Check keybinding store first
      const boundAction = getActionByKeybinding(keyCombo)
      if (boundAction === "view.toggleInlineCommand") {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent("canvas-inline-command"))
        return
      }
      if (boundAction && boundAction.startsWith("action.")) {
        const actionType = boundAction.replace("action.", "")
        const action = CANVAS_ACTIONS.find((a) => a.type === actionType)
        if (action) {
          e.preventDefault()
          const event = new CustomEvent("canvas-action", { detail: action })
          window.dispatchEvent(event)
          return
        }
      }

      // Fallback to default key mapping
      if (keyCombo === "Ctrl+K") {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent("canvas-inline-command"))
        return
      }

      const actionType = DEFAULT_KEY_ACTION_MAP[e.key.toLowerCase()]
      if (actionType) {
        const action = CANVAS_ACTIONS.find((a) => a.type === actionType)
        if (action) {
          e.preventDefault()
          const event = new CustomEvent("canvas-action", { detail: action })
          window.dispatchEvent(event)
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isActive, isProcessing, hasActiveDocument, getActionByKeybinding])
}

export default useCanvasKeyboardShortcuts
