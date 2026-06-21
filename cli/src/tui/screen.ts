/**
 * Alternate-screen (fullscreen) terminal control.
 *
 * The fixed-region layout runs in the terminal's *alternate screen buffer*: a
 * separate, scrollback-free canvas (the same one `vim` / `less` / `htop` use).
 * Entering it preserves the user's existing scrollback untouched; exiting
 * restores the terminal exactly as it was before launch. We also clear the
 * buffer and home the cursor on entry so Ink's first frame paints cleanly.
 *
 * Every writer is guarded for a non-TTY stream (piped stdout in CI) and takes an
 * injectable sink, so the lifecycle is unit-testable without a real terminal.
 * The escapes are idempotent at the terminal level — entering twice or exiting
 * when not in the alternate buffer is harmless — which lets both `mount.tsx`
 * (the hard-exit safety net) and `App` (live `/layout` toggles) own enter/exit
 * without coordinating.
 */

/** Switch INTO the alternate screen buffer (xterm `?1049h`). */
export const ALT_SCREEN_ON = "\x1b[?1049h"
/** Switch back OUT of the alternate screen buffer (xterm `?1049l`). */
export const ALT_SCREEN_OFF = "\x1b[?1049l"
/** Clear the whole screen + scrollback and home the cursor. */
export const CLEAR_HOME = "\x1b[2J\x1b[3J\x1b[H"

/**
 * Enable button (incl. wheel) mouse tracking with SGR extended coordinates.
 * `?1000h` reports button presses — which includes the wheel as button 64/65 —
 * and `?1006h` switches to the unambiguous `ESC[<b;col;row(M|m)` encoding the
 * mouse parser decodes. Needed only in the fullscreen layout: without scrollback
 * the terminal would otherwise turn the wheel into Up/Down arrows that the
 * composer eats as history navigation. (Most terminals still allow Shift+drag to
 * select text while tracking is on.)
 */
export const MOUSE_TRACK_ON = "\x1b[?1000h\x1b[?1006h"
/** Disable the mouse tracking enabled by {@link MOUSE_TRACK_ON}. */
export const MOUSE_TRACK_OFF = "\x1b[?1006l\x1b[?1000l"

/**
 * Disable "alternate scroll" (xterm `?1007l`). Many terminals default it ON,
 * which forges the wheel into Up/Down arrow keys inside the alternate screen —
 * exactly the keys the composer eats as history navigation. Turning it OFF lets
 * us leave mouse tracking entirely off (so native click-drag text selection
 * works) without the wheel corrupting the composer.
 */
export const ALT_SCROLL_OFF = "\x1b[?1007l"

/** The two mouse interaction modes for the fullscreen layout. */
export type MouseMode = "select" | "scroll"

/**
 * Apply a {@link MouseMode} for the fullscreen layout. The two modes are
 * mutually exclusive at the terminal level:
 *   • `"scroll"` (default) captures the wheel via SGR tracking so it scrolls the
 *     transcript, at the cost of native selection (Shift+drag still selects in
 *     most terminals).
 *   • `"select"` leaves the mouse uncaptured so native click-drag selection /
 *     copy works, and disables alternate-scroll so the wheel can't forge arrow
 *     keys into the composer (the wheel simply does nothing — use PgUp/PgDn to
 *     scroll the transcript).
 * No-op on a non-TTY stream.
 */
export function applyMouseMode(mode: MouseMode, out: ScreenStream = process.stdout): void {
  if (!out.isTTY) return
  if (mode === "scroll") {
    out.write(MOUSE_TRACK_ON)
  } else {
    // Ensure any prior tracking (e.g. a live switch from "scroll") is released,
    // then suppress alternate-scroll so the wheel never forges arrow keys.
    out.write(MOUSE_TRACK_OFF)
    out.write(ALT_SCROLL_OFF)
  }
}

/** Tear down mouse tracking so a hard exit never leaves the terminal reporting
 * raw mouse escapes. Idempotent at the terminal level; no-op on a non-TTY. */
export function resetMouse(out: ScreenStream = process.stdout): void {
  if (!out.isTTY) return
  out.write(MOUSE_TRACK_OFF)
}

/** A stdout-like sink we can write escapes to and check for TTY-ness. */
export interface ScreenStream {
  isTTY?: boolean
  write: (data: string) => unknown
}

/**
 * Enter the alternate screen buffer and clear it. No-op when `out` isn't a TTY
 * (a piped stream can't honor the escape — and the layout resolver would have
 * picked scrollback there anyway).
 */
export function enterAltScreen(out: ScreenStream = process.stdout): void {
  if (!out.isTTY) return
  out.write(ALT_SCREEN_ON)
  out.write(CLEAR_HOME)
}

/** Leave the alternate screen buffer, restoring the prior terminal contents. */
export function exitAltScreen(out: ScreenStream = process.stdout): void {
  if (!out.isTTY) return
  out.write(ALT_SCREEN_OFF)
}
