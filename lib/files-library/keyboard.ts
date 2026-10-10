/**
 * Keyboard commands of the Files list (ADR-0223), as a pure decision so the
 * page and its tests agree on them:
 *
 *   ⌘/Ctrl+A        select every item in view
 *   Delete/⌫        Move to Trash (in the Trash: delete forever, confirmed)
 *   F2              rename the one selected item
 *   ↑ / ↓           move to the previous / next item (Shift extends)
 *   Enter           open (handled by the row itself)
 *   Esc             clear the selection, then close the preview
 *
 * Keys typed into a text field, a menu or a dialog are never commands.
 */

export interface FilesKeyInput {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  /** The event came from an input, textarea, select or contenteditable. */
  editable: boolean
}

export interface FilesKeyState {
  /** Item keys in view, in order. */
  order: readonly string[]
  selected: ReadonlySet<string>
  /** The item with focus (or the anchor), if any. */
  current: string | null
  previewOpen: boolean
}

export type FilesKeyCommand =
  | { type: "select-all" }
  | { type: "delete"; keys: string[] }
  | { type: "rename"; key: string }
  | { type: "move"; key: string; extend: boolean }
  | { type: "clear-selection" }
  | { type: "close-preview" }
  | { type: "none" }

const NONE: FilesKeyCommand = { type: "none" }

function targets(state: FilesKeyState): string[] {
  if (state.selected.size > 0) return state.order.filter((key) => state.selected.has(key))
  return state.current ? [state.current] : []
}

export function resolveFilesKey(input: FilesKeyInput, state: FilesKeyState): FilesKeyCommand {
  if (input.editable || input.altKey) return NONE
  const mod = input.metaKey || input.ctrlKey

  if (mod && input.key.toLowerCase() === "a") {
    return state.order.length > 0 ? { type: "select-all" } : NONE
  }
  if (mod) return NONE

  switch (input.key) {
    case "Delete":
    case "Backspace": {
      const keys = targets(state)
      return keys.length > 0 ? { type: "delete", keys } : NONE
    }
    case "F2": {
      const keys = targets(state)
      return keys.length === 1 ? { type: "rename", key: keys[0]! } : NONE
    }
    case "ArrowDown":
    case "ArrowUp": {
      if (state.order.length === 0) return NONE
      const index = state.current ? state.order.indexOf(state.current) : -1
      const step = input.key === "ArrowDown" ? 1 : -1
      const next =
        index === -1
          ? step === 1
            ? 0
            : state.order.length - 1
          : Math.min(state.order.length - 1, Math.max(0, index + step))
      return { type: "move", key: state.order[next]!, extend: input.shiftKey }
    }
    case "Escape":
      if (state.selected.size > 0) return { type: "clear-selection" }
      return state.previewOpen ? { type: "close-preview" } : NONE
    default:
      return NONE
  }
}

/** Whether a key event's target is somewhere text is typed. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false
  const element = target as HTMLElement
  if (element.isContentEditable) return true
  return (
    element.closest(
      "input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog']"
    ) !== null
  )
}
