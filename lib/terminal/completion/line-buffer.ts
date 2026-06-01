/**
 * Local line-editor model for the terminal autocomplete engine.
 *
 * The real line editing happens in the shell (readline / PSReadLine),
 * and what the user sees is echoed back from PTY *output*. We can't read
 * that reliably, so we maintain a parallel, best-effort model of the
 * current input line purely from the *input* keystrokes xterm emits via
 * `onData`. This is enough to drive ghost-text suggestions for the common
 * case (typing a fresh command), and we explicitly mark the line
 * `tracked: false` the moment we see input we can't model (history
 * recall, shell tab-completion, reverse-search, paste) — suggestions are
 * suppressed until the next prompt boundary resets us.
 *
 * Pure + synchronous so it's fully unit-testable without xterm.
 */

export interface LineState {
  /** The command text typed so far at the current prompt. */
  text: string
  /** Cursor offset within `text`. */
  cursor: number
  /**
   * Whether our model still faithfully mirrors the shell's line. Goes
   * false on any input we can't model; reset to true on submit / cancel /
   * prompt boundary. Suggestions only show while tracked.
   */
  tracked: boolean
}

/** A fresh, empty, tracked line. */
export const EMPTY_LINE: LineState = { text: "", cursor: 0, tracked: true }

/** A fresh empty tracked line (new object — safe to mutate by callers). */
export function resetLine(): LineState {
  return { text: "", cursor: 0, tracked: true }
}

const DEL = "\x7f"
const BS = "\b"
const CR = "\r"
const LF = "\n"
const CTRL_A = "\x01"
const CTRL_C = "\x03"
const CTRL_E = "\x05"
const CTRL_K = "\x0b"
const CTRL_L = "\x0c"
const CTRL_U = "\x15"
const CTRL_W = "\x17"
const TAB = "\t"

/** Cursor-movement escape sequences we model exactly. */
const ARROW_RIGHT = new Set(["\x1b[C", "\x1bOC"])
const ARROW_LEFT = new Set(["\x1b[D", "\x1bOD"])
const HOME = new Set(["\x1b[H", "\x1bOH", "\x1b[1~"])
const END = new Set(["\x1b[F", "\x1bOF", "\x1b[4~"])
const FORWARD_DELETE = "\x1b[3~"

function isPrintableRun(chunk: string): boolean {
  for (const ch of chunk) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** Delete the word (plus trailing spaces) immediately before the cursor. */
function killWordBack(state: LineState): LineState {
  let i = state.cursor
  while (i > 0 && state.text[i - 1] === " ") i--
  while (i > 0 && state.text[i - 1] !== " ") i--
  return {
    text: state.text.slice(0, i) + state.text.slice(state.cursor),
    cursor: i,
    tracked: state.tracked,
  }
}

/**
 * Apply one input chunk (the string xterm's `onData` emitted for a single
 * key, paste, or escape sequence) and return the next line state.
 */
export function feedInput(state: LineState, chunk: string): LineState {
  if (chunk === "") return state

  // Submit / cancel — both clear the prompt and re-establish tracking.
  if (chunk === CR || chunk === LF || chunk === CTRL_C) return resetLine()

  // Clear-screen does not touch the line content.
  if (chunk === CTRL_L) return state

  const { text, cursor, tracked } = state

  // Backspace.
  if (chunk === DEL || chunk === BS) {
    if (cursor === 0) return state
    return { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1, tracked }
  }

  // Forward delete.
  if (chunk === FORWARD_DELETE) {
    if (cursor >= text.length) return state
    return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor, tracked }
  }

  // Kill to start / end of line.
  if (chunk === CTRL_U) return { text: text.slice(cursor), cursor: 0, tracked }
  if (chunk === CTRL_K) return { text: text.slice(0, cursor), cursor, tracked }
  if (chunk === CTRL_W) return killWordBack(state)

  // Cursor movement.
  if (chunk === CTRL_A || HOME.has(chunk)) return { text, cursor: 0, tracked }
  if (chunk === CTRL_E || END.has(chunk)) return { text, cursor: text.length, tracked }
  if (ARROW_LEFT.has(chunk)) return { text, cursor: Math.max(0, cursor - 1), tracked }
  if (ARROW_RIGHT.has(chunk)) return { text, cursor: Math.min(text.length, cursor + 1), tracked }

  // Unmodellable: tab-completion, history recall (up/down), reverse-search,
  // bracketed paste, or any other control / escape input. Keep our text
  // best-effort but stop trusting it until the next reset.
  if (chunk === TAB || chunk.startsWith("\x1b") || !isPrintableRun(chunk)) {
    return { text, cursor, tracked: false }
  }

  // Printable insertion at the cursor.
  return {
    text: text.slice(0, cursor) + chunk + text.slice(cursor),
    cursor: cursor + chunk.length,
    tracked,
  }
}

/**
 * Whether the current line can take a ghost-text suggestion: tracked,
 * cursor at the end, and there's some non-blank input to complete.
 */
export function isSuggestible(state: LineState): boolean {
  return state.tracked && state.cursor === state.text.length && state.text.trim().length > 0
}
