/**
 * A2UI Workspace Keyboard Shortcuts
 * Standard keyboard bindings for the workspace editor
 */

import { useEffect, useCallback } from "react"
import { useA2UIStore } from "@/stores/a2ui"

interface WorkspaceShortcutActions {
  surfaceId: string
  onSave?: () => void
  onDeleteComponent?: () => void
  onDuplicateComponent?: () => void
  onDeselect?: () => void
  onToggleMode?: () => void
  enabled?: boolean
}

export function useA2UIWorkspaceShortcuts({
  surfaceId,
  onSave,
  onDeleteComponent,
  onDuplicateComponent,
  onDeselect,
  onToggleMode,
  enabled = true,
}: WorkspaceShortcutActions) {
  const undo = useA2UIStore((state) => state.undo)
  const redo = useA2UIStore((state) => state.redo)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return

      // Guard: don't steal from input fields
      const activeEl = document.activeElement
      const tag = activeEl?.tagName
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (activeEl as HTMLElement)?.isContentEditable
      ) {
        return
      }

      const isCtrl = e.ctrlKey || e.metaKey

      // Ctrl+Z — Undo
      if (isCtrl && e.key === "z" && !e.shiftKey) {
        e.preventDefault()
        undo(surfaceId)
        return
      }

      // Ctrl+Y or Ctrl+Shift+Z — Redo
      if (
        isCtrl &&
        (e.key === "y" || (e.key === "z" && e.shiftKey) || (e.key === "Z" && e.shiftKey))
      ) {
        e.preventDefault()
        redo(surfaceId)
        return
      }

      // Ctrl+S — Save
      if (isCtrl && e.key === "s") {
        e.preventDefault()
        onSave?.()
        return
      }

      // Delete / Backspace — Delete selected component
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        onDeleteComponent?.()
        return
      }

      // Ctrl+D — Duplicate selected component
      if (isCtrl && e.key === "d") {
        e.preventDefault()
        onDuplicateComponent?.()
        return
      }

      // Escape — Deselect / exit mode
      if (e.key === "Escape") {
        e.preventDefault()
        onDeselect?.()
        return
      }

      // Ctrl+E — Toggle Edit/Preview
      if (isCtrl && e.key === "e") {
        e.preventDefault()
        onToggleMode?.()
        return
      }
    },
    [
      enabled,
      surfaceId,
      undo,
      redo,
      onSave,
      onDeleteComponent,
      onDuplicateComponent,
      onDeselect,
      onToggleMode,
    ]
  )

  useEffect(() => {
    if (!enabled) return
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [enabled, handleKeyDown])
}
