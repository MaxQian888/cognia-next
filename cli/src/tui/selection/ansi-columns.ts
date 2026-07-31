/**
 * Column arithmetic over a styled terminal line.
 *
 * In-app text selection works on what is literally on screen: the frame Ink
 * committed (see {@link ./frame-buffer}). That frame is a styled string — SGR
 * colours, OSC hyperlinks, cursor moves — while a mouse report gives a *display
 * column*. Every operation the selection needs therefore has to walk the line
 * once, counting display cells and stepping over escape sequences:
 *
 *   • {@link stripAnsi}     — the plain text the user sees (what gets copied)
 *   • {@link sliceColumns}  — the plain text between two display columns
 *   • {@link highlightColumns} — the same span re-emitted in reverse video,
 *     preserving whatever styling was already there outside the span
 *
 * Pure and dependency-free (beyond {@link stringWidth}), so the whole module
 * unit-tests without a terminal, Ink, or a rendered frame.
 */
import { stringWidth } from "../markdown/width"

/**
 * Matches one terminal escape sequence:
 *   • CSI — `ESC [ … final-byte` (SGR colours, cursor moves, erases)
 *   • OSC — `ESC ] … BEL` or `ESC ] … ESC \` (hyperlinks, titles, OSC 52 copy)
 *   • charset selects — `ESC ( B`, `ESC ) 0`, `ESC # 8`
 *   • every other two-byte escape — `ESC 7` / `ESC 8` (save/restore cursor),
 *     `ESC =`, `ESC >`, `ESC M`, … i.e. ESC plus one byte in `0x30-0x7E`
 * Ordered so the multi-byte forms win over the two-byte fallback (a well-formed
 * CSI is matched whole rather than as a bare `ESC [`).
 */
const ANSI_SEQUENCE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[()#][\s\S]|\x1b[0-~]/

/** Global variant for scanning/stripping (kept separate: a `g` regex is stateful). */
const ANSI_SEQUENCE_G = new RegExp(ANSI_SEQUENCE.source, "g")

/** Strip every escape sequence, leaving the characters the terminal displays. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE_G, "")
}

/**
 * True when `text` carries no displayable character at all — it is pure control
 * traffic (alt-screen switches, mouse-tracking toggles, an OSC 52 clipboard
 * write, a synchronized-update marker). The frame buffer uses this to tell a
 * committed frame apart from the escapes the App writes to the same stream.
 */
export function isControlOnly(text: string): boolean {
  return stripAnsi(text).replace(/[\r\n]/g, "").length === 0
}

/**
 * Sequences that POSITION or ERASE rather than style: cursor up/down/forward/
 * back, column/position, erase-in-line, erase-in-display, a DEC private mode
 * set/reset (`CSI ? 25 l` — cursor visibility), plus a bare CR.
 *
 * Ink wraps each committed frame in exactly this kind of traffic: a
 * hide-cursor + return-to-bottom prefix, `log-update`'s erase-the-previous-frame
 * run, and — when a component parked Ink's cursor — a reposition suffix. Those
 * bytes belong to the *transition between* frames, not to the frame's content:
 * re-emitting them while repainting a row would rewind the cursor and smear the
 * screen, and leaving them attached would corrupt the first/last row's text.
 * Both strippers drop exactly that run and keep everything else — notably SGR
 * (`…m`), which legitimately opens a line's colour.
 */
const CURSOR_CONTROL = String.raw`\x1b\[\?[0-9;]*[hl]|\x1b\[[0-9;]*[ABCDEFGHJKfd]|\r`

const LEADING_CURSOR_CONTROL = new RegExp(`^(?:${CURSOR_CONTROL})+`)
const TRAILING_CURSOR_CONTROL = new RegExp(`(?:${CURSOR_CONTROL})+$`)

/** Drop the cursor-move / erase run Ink prefixes onto a frame. */
export function stripLeadingCursorControls(text: string): string {
  return text.replace(LEADING_CURSOR_CONTROL, "")
}

/** Drop the cursor-reposition run Ink may append after a frame. */
export function stripTrailingCursorControls(text: string): string {
  return text.replace(TRAILING_CURSOR_CONTROL, "")
}

/** One step of a walk across a styled line: either an escape or a real glyph. */
interface Token {
  text: string
  /** Display cells this token occupies — 0 for an escape sequence. */
  width: number
}

/** Split a styled line into escape sequences and width-carrying glyphs. */
function tokenize(line: string): Token[] {
  const tokens: Token[] = []
  let rest = line
  while (rest.length > 0) {
    const m = ANSI_SEQUENCE.exec(rest)
    if (m && m.index === 0) {
      tokens.push({ text: m[0], width: 0 })
      rest = rest.slice(m[0].length)
      continue
    }
    // Consume up to the next escape as plain text, glyph by glyph (so a wide
    // CJK character stays one token and counts as two cells).
    const end = m ? m.index : rest.length
    for (const ch of rest.slice(0, end)) tokens.push({ text: ch, width: stringWidth(ch) })
    rest = rest.slice(end)
  }
  return tokens
}

/**
 * The plain text of `line` between display columns `start` (inclusive) and
 * `end` (exclusive), both 0-based. A glyph is included when its FIRST cell
 * falls inside the range, so a wide character straddling the boundary is taken
 * whole rather than split into an unusable half. Columns past the end of the
 * line contribute nothing (no padding — copied text shouldn't carry phantom
 * trailing spaces).
 */
export function sliceColumns(line: string, start: number, end: number): string {
  if (end <= start) return ""
  let col = 0
  let out = ""
  for (const token of tokenize(line)) {
    if (token.width === 0) continue
    if (col >= end) break
    if (col >= start) out += token.text
    col += token.width
  }
  return out
}

/** SGR "reverse video on" / "reverse video off". */
const REVERSE_ON = "\x1b[7m"
const REVERSE_OFF = "\x1b[27m"

/**
 * Re-emit `line` with the display columns `[start, end)` in reverse video,
 * leaving every other escape sequence exactly where it was so the row keeps its
 * original colours outside the selection.
 *
 * When the range reaches past the line's last glyph the remainder is padded with
 * highlighted spaces — that is what a terminal's own selection does for the
 * middle rows of a multi-row drag, and without it a short line would show a
 * ragged selection edge.
 */
export function highlightColumns(line: string, start: number, end: number): string {
  if (end <= start) return line
  let col = 0
  let inside = false
  let out = ""
  for (const token of tokenize(line)) {
    if (token.width === 0) {
      // An escape inside the highlighted span may reset attributes (Ink closes
      // colours with `0m`), which would also clear the reverse video. Re-assert
      // it after the sequence so the span stays contiguous.
      out += inside ? `${token.text}${REVERSE_ON}` : token.text
      continue
    }
    const shouldHighlight = col >= start && col < end
    if (shouldHighlight && !inside) {
      out += REVERSE_ON
      inside = true
    } else if (!shouldHighlight && inside) {
      out += REVERSE_OFF
      inside = false
    }
    out += token.text
    col += token.width
  }
  if (col < end) {
    // Pad the tail of a short line so the selection edge stays straight. When
    // the span starts past the last glyph, the gap before it stays unstyled.
    if (col < start) {
      out += " ".repeat(start - col)
      col = start
    }
    if (!inside) {
      out += REVERSE_ON
      inside = true
    }
    out += " ".repeat(end - col)
  }
  if (inside) out += REVERSE_OFF
  return out
}
