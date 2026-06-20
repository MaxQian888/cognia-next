/**
 * Translate a raw Ink key event into a high-level editor intent. Pure: all the
 * decision logic lives here so the `Input` component's `useInput` callback stays
 * a two-line `dispatch(interpretKey(...))`, and every branch is unit-tested
 * without rendering Ink.
 */
import { DEFAULT_KEYBINDINGS, matchKeySpec } from "./keybindings"

export interface KeyFlags {
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  return?: boolean
  escape?: boolean
  tab?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
}

export interface KeyContext {
  /** A slash/file completion popup is open. */
  popupOpen: boolean
  /** Cursor is on the first buffer line (gates history-up vs move-up). */
  onFirstLine: boolean
  /** Cursor is on the last buffer line (gates history-down vs move-down). */
  onLastLine: boolean
}

export type KeyIntent =
  | { type: "submit" }
  | { type: "newline" }
  | { type: "insert"; text: string }
  | { type: "backspace" }
  | { type: "delete-word" }
  /** Kill from the cursor to the start of the line (Ctrl+U). */
  | { type: "kill-to-start" }
  /** Kill from the cursor to the end of the line (Ctrl+K). */
  | { type: "kill-to-end" }
  /** Undo the last text edit (Ctrl+Z). */
  | { type: "undo" }
  /** Redo the last undone edit (Ctrl+Y). */
  | { type: "redo" }
  | {
      type: "move"
      dir: "left" | "right" | "up" | "down" | "home" | "end" | "word-left" | "word-right"
    }
  | { type: "history"; dir: "up" | "down" }
  | { type: "popup-move"; delta: number }
  | { type: "popup-accept" }
  /** Tab on an open popup: complete in place (insert) rather than submit/accept. */
  | { type: "popup-complete" }
  | { type: "popup-cancel" }
  | { type: "interrupt" }
  | { type: "none" }

export function interpretKey(
  input: string,
  key: KeyFlags,
  ctx: KeyContext,
  /** Resolved editor key bindings; defaults preserve the historic emacs chords. */
  bindings: Record<string, string> = DEFAULT_KEYBINDINGS
): KeyIntent {
  // Ctrl+C is handled by the App's global handler (double-press-to-exit + hint);
  // the composer ignores it so the two handlers don't race.
  if (key.ctrl && input === "c") return { type: "none" }

  if (key.escape) return ctx.popupOpen ? { type: "popup-cancel" } : { type: "interrupt" }

  if (key.tab) return ctx.popupOpen ? { type: "popup-complete" } : { type: "none" }

  if (key.return) {
    if (ctx.popupOpen) return { type: "popup-accept" }
    if (key.shift || key.meta) return { type: "newline" }
    return { type: "submit" }
  }

  if (key.upArrow) {
    if (ctx.popupOpen) return { type: "popup-move", delta: -1 }
    return ctx.onFirstLine ? { type: "history", dir: "up" } : { type: "move", dir: "up" }
  }
  if (key.downArrow) {
    if (ctx.popupOpen) return { type: "popup-move", delta: 1 }
    return ctx.onLastLine ? { type: "history", dir: "down" } : { type: "move", dir: "down" }
  }

  // Ctrl/Alt + arrow jumps by word; a bare arrow moves one column. Terminals that
  // don't send the modifier degrade gracefully to single-column movement.
  if (key.leftArrow) return { type: "move", dir: key.ctrl || key.meta ? "word-left" : "left" }
  if (key.rightArrow) return { type: "move", dir: key.ctrl || key.meta ? "word-right" : "right" }

  // Backspace and the Del key are conflated on purpose: many terminals report the
  // Backspace key as `key.delete` (raw 0x7F), so treating Del as forward-delete
  // would break Backspace. Both delete the character to the left.
  if (key.backspace || key.delete) return { type: "backspace" }

  // Emacs-style line motions + kills (rebindable via the keybindings table; the
  // defaults are ctrl+a / ctrl+e / ctrl+w / ctrl+u / ctrl+k).
  if (matchKeySpec(bindings.lineHome ?? "", input, key)) return { type: "move", dir: "home" }
  if (matchKeySpec(bindings.lineEnd ?? "", input, key)) return { type: "move", dir: "end" }
  if (matchKeySpec(bindings.deleteWord ?? "", input, key)) return { type: "delete-word" }
  if (matchKeySpec(bindings.lineKillToStart ?? "", input, key)) return { type: "kill-to-start" }
  if (matchKeySpec(bindings.lineKillToEnd ?? "", input, key)) return { type: "kill-to-end" }
  if (matchKeySpec(bindings.undo ?? "", input, key)) return { type: "undo" }
  if (matchKeySpec(bindings.redo ?? "", input, key)) return { type: "redo" }

  // Printable text (ignore other control chords).
  if (input && !key.ctrl && !key.meta) return { type: "insert", text: input }

  return { type: "none" }
}
