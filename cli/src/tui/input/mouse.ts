/**
 * Parse a terminal mouse event that Ink surfaced as a raw `input` string.
 *
 * In the fullscreen (alternate-screen) layout there is no native scrollback, so
 * a terminal would otherwise translate the mouse wheel into Up/Down arrow keys —
 * which the composer swallows as command-history navigation, so "scroll" silently
 * "switches commands". To fix that at the source we enable SGR mouse tracking
 * (see `screen.ts`), and the terminal reports wheel/button events as
 * `ESC[<b;col;row` followed by `M` (press) or `m` (release).
 *
 * Ink doesn't understand those sequences: it strips the leading ESC and hands the
 * remainder (`[<b;col;row M`) to every `useInput` handler as plain text. Left
 * unguarded that text gets inserted into whatever field is focused. This pure
 * parser recognises the sequence so the App can route wheel events to the scroll
 * viewport and every text input can ignore the rest. Pure → unit-tested without a
 * real terminal.
 */

/** Modifier keys held during a mouse report, decoded from the SGR button bits. */
export interface MouseModifiers {
  ctrl: boolean
  /** Alt / Option / Meta — terminals report all three on the same bit. */
  alt: boolean
  shift: boolean
}

/**
 * A decoded terminal mouse event.
 *
 * The wheel carries a scroll direction; the button events carry their 1-based
 * `col`/`row` (so the composer can place the cursor where the user clicked, and
 * the selection controller can anchor a drag) plus the modifiers that were held.
 * `drag` / `release` only arrive while button-event tracking (`?1002h`) is on —
 * see {@link ../screen.applyMouseMode}. Non-left buttons collapse to `other` so
 * callers can swallow them without acting.
 */
export type MouseEvent =
  | { kind: "wheel"; dir: "up" | "down" }
  | { kind: "click"; col: number; row: number; mods: MouseModifiers }
  | { kind: "drag"; col: number; row: number; mods: MouseModifiers }
  | { kind: "release"; col: number; row: number; mods: MouseModifiers }
  | { kind: "other" }

// SGR mouse report, with the leading ESC optionally already stripped by Ink:
//   ESC [ < button ; col ; row (M|m)   (M = press, m = release)
const SGR_MOUSE = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/

// The wheel sets bit 6 of the button code (64); bit 0 then selects the direction
// (0 = up, 1 = down). Bit 5 (32) marks a drag/motion event; the low two bits pick
// the button (0 = left). Modifier bits (shift 4 / alt 8 / ctrl 16) may also be
// OR-ed in, so we mask rather than compare exact values.
const WHEEL_BIT = 0b100_0000
const MOTION_BIT = 0b10_0000
const BUTTON_MASK = 0b11
const DIR_BIT = 0b1
const SHIFT_BIT = 0b100
const ALT_BIT = 0b1000
const CTRL_BIT = 0b1_0000

/** Decode the modifier bits of an SGR button code. */
function modifiers(button: number): MouseModifiers {
  return {
    ctrl: (button & CTRL_BIT) !== 0,
    alt: (button & ALT_BIT) !== 0,
    shift: (button & SHIFT_BIT) !== 0,
  }
}

/** Decode a raw `input` string into a {@link MouseEvent}, or null when it isn't a
 * mouse report at all. */
export function parseMouseEvent(input: string): MouseEvent | null {
  const m = SGR_MOUSE.exec(input)
  if (!m) return null
  const button = Number(m[1])
  if ((button & WHEEL_BIT) !== 0) {
    const direction = button & BUTTON_MASK
    // SGR uses 64/65 for vertical up/down and 66/67 for horizontal left/right.
    // A trackpad routinely emits small horizontal momentum alongside a vertical
    // gesture; mapping 66/67 through bit 0 turns that jitter into alternating
    // up/down events and makes the viewport visibly rebound.
    if (direction > DIR_BIT) return { kind: "other" }
    return { kind: "wheel", dir: direction === 0 ? "up" : "down" }
  }
  const col = Number(m[2])
  const row = Number(m[3])
  const mods = modifiers(button)
  // A release (`m`) ends whatever gesture was in flight. Terminals disagree on
  // the button code they report on release (some send the released button, some
  // send 3 = "no button"), so we don't filter on it — the caller knows which
  // gesture it started.
  if (m[4] === "m") return { kind: "release", col, row, mods }
  // Motion while a button is held. Only a left drag drives a selection;
  // middle/right drags are swallowed.
  if ((button & MOTION_BIT) !== 0) {
    return (button & BUTTON_MASK) === 0 ? { kind: "drag", col, row, mods } : { kind: "other" }
  }
  // A bare left-button PRESS is a click the composer / panels can act on.
  if ((button & BUTTON_MASK) === 0) return { kind: "click", col, row, mods }
  return { kind: "other" }
}

/** True when `input` is any terminal mouse report — used by text fields to ignore
 * the sequence instead of inserting it as literal characters. */
export function isMouseSequence(input: string): boolean {
  return SGR_MOUSE.test(input)
}
