/**
 * Translate a raw Ink key event into a high-level editor intent. Pure: all the
 * decision logic lives here so the `Input` component's `useInput` callback stays
 * a two-line `dispatch(interpretKey(...))`, and every branch is unit-tested
 * without rendering Ink.
 */
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
  | { type: "move"; dir: "left" | "right" | "up" | "down" | "home" | "end" }
  | { type: "history"; dir: "up" | "down" }
  | { type: "popup-move"; delta: number }
  | { type: "popup-accept" }
  /** Tab on an open popup: complete in place (insert) rather than submit/accept. */
  | { type: "popup-complete" }
  | { type: "popup-cancel" }
  | { type: "interrupt" }
  | { type: "none" }

export function interpretKey(input: string, key: KeyFlags, ctx: KeyContext): KeyIntent {
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

  if (key.leftArrow) return { type: "move", dir: "left" }
  if (key.rightArrow) return { type: "move", dir: "right" }

  if (key.backspace || key.delete) return { type: "backspace" }

  // Emacs-style line motions + word delete.
  if (key.ctrl && input === "a") return { type: "move", dir: "home" }
  if (key.ctrl && input === "e") return { type: "move", dir: "end" }
  if (key.ctrl && input === "w") return { type: "delete-word" }

  // Printable text (ignore other control chords).
  if (input && !key.ctrl && !key.meta) return { type: "insert", text: input }

  return { type: "none" }
}
