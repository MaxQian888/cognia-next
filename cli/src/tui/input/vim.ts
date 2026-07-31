/**
 * Vim editing mode for the composer (Claude Code parity, `/vim` to toggle).
 *
 * A pure NORMAL-mode key interpreter over the composer's {@link InputBuffer}:
 * the `Input` component feeds NORMAL-mode keys here and applies the returned
 * buffer/state; INSERT mode is the composer's normal behaviour (Esc drops back
 * to NORMAL via {@link enterNormalFromInsert}).
 *
 * Scoped subset (the motions/operators that matter in a one-shot composer):
 *   modes    i a I A o O · Esc
 *   motions  h j k l · arrows · w b e · 0 ^ $ · gg G · counts (e.g. 3w)
 *   edits    x X · dd dw de d$ D · cc cw ce c$ C S · s · yy p P
 *   other    u (undo) · Ctrl+R (redo) · Enter (submit)
 *
 * Operator+motion spans (`dw`/`ce`/…) are clamped to the current line — a
 * composer draft is a handful of lines, not a file; linewise `dd`/`cc`/`yy`
 * cover the multi-line cases.
 */
import { moveWordLeft } from "./buffer"
import type { KeyFlags } from "./keymap"
import type { InputBuffer } from "../state/types"

export type VimMode = "insert" | "normal"

/** The last deleted/yanked text; linewise registers paste as whole lines. */
export interface VimRegister {
  text: string
  linewise: boolean
}

export interface VimState {
  mode: VimMode
  /** Pending operator (`d`/`c`/`y`) or `g` prefix awaiting its motion. */
  pending: "d" | "c" | "y" | "g" | null
  /** Count prefix accumulator (digits typed so far, `""` = none). */
  count: string
  register: VimRegister | null
}

export function initialVimState(): VimState {
  return { mode: "insert", pending: null, count: "", register: null }
}

/** A side effect the composer must perform (delegated to its existing paths). */
export type VimRequest = "undo" | "redo" | "submit"

export interface VimKeyResult {
  state: VimState
  buffer: InputBuffer
  request?: VimRequest
  /** False → the key isn't vim's (control chords etc.); run the default flow. */
  handled: boolean
}

// ── Cursor / span primitives ─────────────────────────────────────────────────

/** NORMAL-mode column clamp: the cursor sits ON a character (or col 0). */
function clampCol(line: string, col: number): number {
  return Math.max(0, Math.min(col, Math.max(0, line.length - 1)))
}

function withCursor(b: InputBuffer, row: number, col: number): InputBuffer {
  const r = Math.max(0, Math.min(row, b.lines.length - 1))
  return { lines: b.lines, cursorRow: r, cursorCol: clampCol(b.lines[r], col) }
}

/** Leaving INSERT: vim pulls the cursor one column left (onto the last-typed char). */
export function enterNormalFromInsert(b: InputBuffer): InputBuffer {
  return withCursor(b, b.cursorRow, b.cursorCol - 1)
}

function firstNonBlankCol(line: string): number {
  const m = line.match(/\S/)
  return m?.index ?? 0
}

/** Start of the NEXT word (vim `w`) — emacs' word-right stops at word END,
 * so this is implemented here rather than reusing `moveWordRight`. */
function nextWordStartCol(line: string, col: number): number {
  let i = col
  while (i < line.length && /\S/.test(line[i])) i++
  while (i < line.length && /\s/.test(line[i])) i++
  return i
}

/** End-of-word column (vim `e`): the LAST char of the current/next word. */
function wordEndCol(line: string, col: number): number {
  let i = col + 1
  while (i < line.length && /\s/.test(line[i])) i++
  if (i >= line.length) return clampCol(line, col)
  while (i + 1 < line.length && /\S/.test(line[i + 1])) i++
  return i
}

/** Delete `[start, end)` on the cursor line; returns the removed text. */
function deleteSpan(b: InputBuffer, start: number, end: number): { b: InputBuffer; cut: string } {
  const line = b.lines[b.cursorRow]
  const s = Math.max(0, Math.min(start, end))
  const e = Math.min(line.length, Math.max(start, end))
  if (s === e) return { b, cut: "" }
  const lines = [...b.lines]
  lines[b.cursorRow] = line.slice(0, s) + line.slice(e)
  return {
    b: { lines, cursorRow: b.cursorRow, cursorCol: clampCol(lines[b.cursorRow], s) },
    cut: line.slice(s, e),
  }
}

/** Delete `n` whole lines from `row`; the buffer never drops below one line. */
function deleteLines(b: InputBuffer, row: number, n: number): { b: InputBuffer; cut: string } {
  const end = Math.min(b.lines.length, row + n)
  const cut = b.lines.slice(row, end).join("\n")
  const lines = [...b.lines.slice(0, row), ...b.lines.slice(end)]
  if (lines.length === 0) lines.push("")
  const cursorRow = Math.min(row, lines.length - 1)
  return { b: { lines, cursorRow, cursorCol: firstNonBlankCol(lines[cursorRow]) }, cut }
}

/** Resolve a charwise motion to its span end (exclusive) on the cursor line. */
function motionSpanEnd(b: InputBuffer, motion: string, count: number): number | null {
  const line = b.lines[b.cursorRow]
  let col = b.cursorCol
  switch (motion) {
    case "w": {
      let col = b.cursorCol
      for (let i = 0; i < count; i++) col = nextWordStartCol(line, col)
      return col // already clamped to the line by construction
    }
    case "e": {
      for (let i = 0; i < count; i++) col = wordEndCol(line, col)
      return Math.min(line.length, col + 1) // include the end char
    }
    case "$":
      return line.length
    default:
      return null
  }
}

/** Resolve a backwards charwise motion to its span start on the cursor line. */
function motionSpanStart(b: InputBuffer, motion: string, count: number): number | null {
  switch (motion) {
    case "b": {
      let probe: InputBuffer = b
      for (let i = 0; i < count; i++) probe = moveWordLeft(probe)
      return probe.cursorRow === b.cursorRow ? probe.cursorCol : 0
    }
    case "0":
      return 0
    default:
      return null
  }
}

// ── The NORMAL-mode key interpreter ──────────────────────────────────────────

const cleared = (s: VimState): VimState => ({ ...s, pending: null, count: "" })
const toInsert = (s: VimState): VimState => ({ ...cleared(s), mode: "insert" })

/**
 * Interpret one NORMAL-mode key. Pure: returns the next vim state, the next
 * buffer, and any request the composer should run through its existing paths
 * (undo/redo/submit). `handled: false` hands control chords and other
 * non-vim keys back to the default composer flow.
 */
export function handleVimNormalKey(
  input: string,
  key: KeyFlags,
  state: VimState,
  buffer: InputBuffer
): VimKeyResult {
  const done = (s: VimState, b: InputBuffer, request?: VimRequest): VimKeyResult => ({
    state: s,
    buffer: b,
    request,
    handled: true,
  })
  const b = buffer
  const line = b.lines[b.cursorRow]
  const count = state.count === "" ? 1 : Math.max(1, parseInt(state.count, 10))

  // Enter submits from NORMAL too — the composer is still a prompt box.
  if (key.return) return done(cleared(state), b, "submit")
  // Esc clears a pending operator/count; with nothing pending it's a no-op
  // (the App's global Esc behaviours only fire while the turn is busy).
  if (key.escape) return done(cleared(state), b)
  // Ctrl+R = redo; every other control chord belongs to the default flow
  // (rebindable app chords like Ctrl+F/Ctrl+R-history are gated off in vim's
  // NORMAL mode only for plain keys).
  if (key.ctrl || key.meta) {
    if (key.ctrl && input === "r") return done(cleared(state), b, "redo")
    return { state, buffer: b, handled: false }
  }
  // Arrows move like h/j/k/l (shared clamp).
  if (key.leftArrow) return done(cleared(state), withCursor(b, b.cursorRow, b.cursorCol - count))
  if (key.rightArrow) return done(cleared(state), withCursor(b, b.cursorRow, b.cursorCol + count))
  if (key.upArrow) return done(cleared(state), withCursor(b, b.cursorRow - count, b.cursorCol))
  if (key.downArrow) return done(cleared(state), withCursor(b, b.cursorRow + count, b.cursorCol))
  // Backspace = move left (vim NORMAL never deletes on backspace).
  if (key.backspace || key.delete)
    return done(cleared(state), withCursor(b, b.cursorRow, b.cursorCol - 1))
  if (!input) return done(state, b)

  const ch = input[0]

  // Count prefix: 1-9 always; 0 only continues an existing count (else motion).
  if (/[1-9]/.test(ch) || (ch === "0" && state.count !== "")) {
    return done({ ...state, count: state.count + ch }, b)
  }

  // `g` prefix → `gg` (go to line `count`, default first).
  if (state.pending === "g") {
    if (ch === "g") {
      const row = state.count === "" ? 0 : count - 1
      return done(
        cleared(state),
        withCursor(
          b,
          row,
          firstNonBlankCol(b.lines[Math.max(0, Math.min(row, b.lines.length - 1))])
        )
      )
    }
    return done(cleared(state), b)
  }

  // Operator pending → resolve its motion (or the doubled linewise form).
  if (state.pending === "d" || state.pending === "c" || state.pending === "y") {
    const op = state.pending
    if (ch === op) {
      // dd / cc / yy — linewise on `count` lines.
      if (op === "y") {
        const cut = b.lines.slice(b.cursorRow, b.cursorRow + count).join("\n")
        return done({ ...cleared(state), register: { text: cut, linewise: true } }, b)
      }
      const { b: next, cut } = deleteLines(b, b.cursorRow, count)
      const reg = { text: cut, linewise: true }
      if (op === "c") {
        // cc: reopen an empty line in place and insert.
        const lines = [...next.lines.slice(0, b.cursorRow), "", ...next.lines.slice(b.cursorRow)]
        const reopened =
          next.lines.length === 1 && next.lines[0] === ""
            ? next
            : { lines, cursorRow: b.cursorRow, cursorCol: 0 }
        return {
          state: { ...toInsert(state), register: reg },
          buffer: { ...reopened, cursorCol: 0 },
          handled: true,
        }
      }
      return done({ ...cleared(state), register: reg }, next)
    }
    const end = motionSpanEnd(b, ch, count)
    const start = motionSpanStart(b, ch, count)
    if (end !== null || start !== null) {
      const s = start ?? b.cursorCol
      const e = end ?? b.cursorCol
      if (op === "y") {
        const [lo, hi] = s <= e ? [s, e] : [e, s]
        return done(
          { ...cleared(state), register: { text: line.slice(lo, hi), linewise: false } },
          b
        )
      }
      const { b: next, cut } = deleteSpan(b, s, e)
      const st = {
        ...(op === "c" ? toInsert(state) : cleared(state)),
        register: { text: cut, linewise: false },
      }
      // `c` leaves the cursor where the span began, ready to type (col may sit
      // one past the last char, which INSERT mode allows).
      const buf =
        op === "c" ? { ...next, cursorCol: Math.min(s, next.lines[next.cursorRow].length) } : next
      return { state: st, buffer: buf, handled: true }
    }
    return done(cleared(state), b) // unknown motion — drop the operator
  }

  switch (ch) {
    // ── mode changes ──
    case "i":
      return { state: toInsert(state), buffer: b, handled: true }
    case "a":
      return {
        state: toInsert(state),
        buffer: { ...b, cursorCol: Math.min(line.length, b.cursorCol + 1) },
        handled: true,
      }
    case "I":
      return {
        state: toInsert(state),
        buffer: { ...b, cursorCol: firstNonBlankCol(line) },
        handled: true,
      }
    case "A":
      return { state: toInsert(state), buffer: { ...b, cursorCol: line.length }, handled: true }
    case "o": {
      const lines = [...b.lines.slice(0, b.cursorRow + 1), "", ...b.lines.slice(b.cursorRow + 1)]
      return {
        state: toInsert(state),
        buffer: { lines, cursorRow: b.cursorRow + 1, cursorCol: 0 },
        handled: true,
      }
    }
    case "O": {
      const lines = [...b.lines.slice(0, b.cursorRow), "", ...b.lines.slice(b.cursorRow)]
      return {
        state: toInsert(state),
        buffer: { lines, cursorRow: b.cursorRow, cursorCol: 0 },
        handled: true,
      }
    }

    // ── motions ──
    case "h":
      return done(cleared(state), withCursor(b, b.cursorRow, b.cursorCol - count))
    case "l":
      return done(cleared(state), withCursor(b, b.cursorRow, b.cursorCol + count))
    case "k":
      return done(cleared(state), withCursor(b, b.cursorRow - count, b.cursorCol))
    case "j":
      return done(cleared(state), withCursor(b, b.cursorRow + count, b.cursorCol))
    case "w": {
      let row = b.cursorRow
      let col = b.cursorCol
      for (let i = 0; i < count; i++) {
        const next = nextWordStartCol(b.lines[row], col)
        if (next >= b.lines[row].length && row < b.lines.length - 1) {
          // Wrap to the next line's first word (vim `w` crosses newlines).
          row += 1
          col = firstNonBlankCol(b.lines[row])
        } else {
          col = next
        }
      }
      return done(cleared(state), withCursor(b, row, col))
    }
    case "b": {
      let probe: InputBuffer = b
      for (let i = 0; i < count; i++) probe = moveWordLeft(probe)
      return done(cleared(state), withCursor(probe, probe.cursorRow, probe.cursorCol))
    }
    case "e":
      return done(cleared(state), withCursor(b, b.cursorRow, wordEndCol(line, b.cursorCol)))
    case "0":
      return done(cleared(state), withCursor(b, b.cursorRow, 0))
    case "^":
      return done(cleared(state), withCursor(b, b.cursorRow, firstNonBlankCol(line)))
    case "$":
      return done(cleared(state), withCursor(b, b.cursorRow, line.length - 1))
    case "G": {
      const row = state.count === "" ? b.lines.length - 1 : count - 1
      const target = Math.max(0, Math.min(row, b.lines.length - 1))
      return done(cleared(state), withCursor(b, target, firstNonBlankCol(b.lines[target])))
    }
    case "g":
      return done({ ...state, pending: "g" }, b)

    // ── operators ──
    case "d":
    case "c":
    case "y":
      return done({ ...state, pending: ch }, b)

    // ── edits ──
    case "x": {
      const { b: next, cut } = deleteSpan(b, b.cursorCol, b.cursorCol + count)
      return done(
        { ...cleared(state), register: cut ? { text: cut, linewise: false } : state.register },
        next
      )
    }
    case "X": {
      const { b: next, cut } = deleteSpan(b, b.cursorCol - count, b.cursorCol)
      return done(
        { ...cleared(state), register: cut ? { text: cut, linewise: false } : state.register },
        next
      )
    }
    case "D": {
      const { b: next, cut } = deleteSpan(b, b.cursorCol, line.length)
      return done({ ...cleared(state), register: { text: cut, linewise: false } }, next)
    }
    case "C": {
      const { b: next, cut } = deleteSpan(b, b.cursorCol, line.length)
      return {
        state: { ...toInsert(state), register: { text: cut, linewise: false } },
        buffer: { ...next, cursorCol: Math.min(b.cursorCol, next.lines[next.cursorRow].length) },
        handled: true,
      }
    }
    case "s": {
      const { b: next, cut } = deleteSpan(b, b.cursorCol, b.cursorCol + count)
      return {
        state: {
          ...toInsert(state),
          register: cut ? { text: cut, linewise: false } : state.register,
        },
        buffer: { ...next, cursorCol: Math.min(b.cursorCol, next.lines[next.cursorRow].length) },
        handled: true,
      }
    }
    case "S": {
      const reg = { text: line, linewise: true }
      const lines = [...b.lines]
      lines[b.cursorRow] = ""
      return {
        state: { ...toInsert(state), register: reg },
        buffer: { lines, cursorRow: b.cursorRow, cursorCol: 0 },
        handled: true,
      }
    }
    case "p":
    case "P": {
      const reg = state.register
      if (!reg || reg.text === "") return done(cleared(state), b)
      if (reg.linewise) {
        const at = ch === "p" ? b.cursorRow + 1 : b.cursorRow
        const lines = [...b.lines.slice(0, at), ...reg.text.split("\n"), ...b.lines.slice(at)]
        return done(cleared(state), {
          lines,
          cursorRow: at,
          cursorCol: firstNonBlankCol(reg.text.split("\n")[0]),
        })
      }
      const at = ch === "p" ? Math.min(line.length, b.cursorCol + 1) : b.cursorCol
      const lines = [...b.lines]
      lines[b.cursorRow] = line.slice(0, at) + reg.text + line.slice(at)
      return done(cleared(state), {
        lines,
        cursorRow: b.cursorRow,
        cursorCol: clampCol(lines[b.cursorRow], at + reg.text.length - 1),
      })
    }
    case "u":
      return done(cleared(state), b, "undo")

    default:
      // Unknown NORMAL key: swallow it (never insert text in NORMAL mode).
      return done(cleared(state), b)
  }
}
