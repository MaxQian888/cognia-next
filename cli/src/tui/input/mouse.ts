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

/** A decoded terminal mouse event. The wheel carries a scroll direction; a
 * left-button press carries its 1-based `col`/`row` (so the composer can place
 * the cursor where the user clicked); everything else (drags, releases, other
 * buttons) collapses to `other` so callers can swallow it without acting. */
export type MouseEvent =
  | { kind: "wheel"; dir: "up" | "down" }
  | { kind: "click"; col: number; row: number }
  | { kind: "other" }

// SGR mouse report, with the leading ESC optionally already stripped by Ink:
//   ESC [ < button ; col ; row (M|m)   (M = press, m = release)
const SGR_MOUSE = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/

// The wheel sets bit 6 of the button code (64); bit 0 then selects the direction
// (0 = up, 1 = down). Bit 5 (32) marks a drag/motion event; the low two bits pick
// the button (0 = left). Modifier bits (ctrl/meta/shift) may also be OR-ed in, so
// we mask rather than compare exact values.
const WHEEL_BIT = 0b100_0000
const MOTION_BIT = 0b10_0000
const BUTTON_MASK = 0b11
const DIR_BIT = 0b1

/** Decode a raw `input` string into a {@link MouseEvent}, or null when it isn't a
 * mouse report at all. */
export function parseMouseEvent(input: string): MouseEvent | null {
  const m = SGR_MOUSE.exec(input)
  if (!m) return null
  const button = Number(m[1])
  if ((button & WHEEL_BIT) !== 0) {
    return { kind: "wheel", dir: (button & DIR_BIT) === 0 ? "up" : "down" }
  }
  // A bare left-button PRESS (no wheel/motion bits, button 0, suffix `M`) is a
  // click the composer can act on; drags/releases/other buttons are swallowed.
  if (m[4] === "M" && (button & MOTION_BIT) === 0 && (button & BUTTON_MASK) === 0) {
    return { kind: "click", col: Number(m[2]), row: Number(m[3]) }
  }
  return { kind: "other" }
}

/** True when `input` is any terminal mouse report — used by text fields to ignore
 * the sequence instead of inserting it as literal characters. */
export function isMouseSequence(input: string): boolean {
  return SGR_MOUSE.test(input)
}
