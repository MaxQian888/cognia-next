/**
 * A2UI Workspace Keyboard Shortcuts — rebindable bindings for the workspace
 * editor, registered while mounted (and only while `enabled`):
 *
 *   a2ui.undo            Ctrl+Z
 *   a2ui.redo            Ctrl+Y / Ctrl+Shift+Z
 *   a2ui.save            Ctrl+S
 *   a2ui.deleteComponent Delete / Backspace
 *   a2ui.duplicate       Ctrl+D
 *   a2ui.deselect        Escape
 *   a2ui.toggleMode      Ctrl+E
 *
 * The single dispatcher owns the listener + editable guard, so these never fire
 * while the user is typing in a field. Each handler `preventDefault`s exactly as
 * the pre-migration code did.
 */

import { useA2UIStore } from "@/stores/a2ui"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"

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

  const opts = { enabled, preventDefault: true }

  useAppShortcut("a2ui.undo", () => undo(surfaceId), opts)
  useAppShortcut("a2ui.redo", () => redo(surfaceId), opts)
  useAppShortcut("a2ui.save", () => onSave?.(), opts)
  useAppShortcut("a2ui.deleteComponent", () => onDeleteComponent?.(), opts)
  useAppShortcut("a2ui.duplicate", () => onDuplicateComponent?.(), opts)
  useAppShortcut("a2ui.deselect", () => onDeselect?.(), opts)
  useAppShortcut("a2ui.toggleMode", () => onToggleMode?.(), opts)
}
