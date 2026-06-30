/**
 * Pure helpers + constants extracted from {@link App}. Keeping them in a sibling
 * module shrinks the root component and lets each be unit-tested in isolation
 * (no Ink render needed).
 */
import fs from "node:fs"

export const DOUBLE_CTRL_C_MS = 1000

// Rows the transcript scrolls per mouse-wheel notch in the fullscreen layout.
export const WHEEL_SCROLL_LINES = 3

// A terminal resize fires a burst of events during a drag. Repainting `<Static>`
// (clear screen + reprint every cell) on each one smears and flickers, so the
// heavy repaint is debounced until the drag settles. The live frame still
// reflows instantly because its width is driven by the (immediate) size hook.
export const RESIZE_DEBOUNCE_MS = 120

// Clear the screen + scrollback + home the cursor. `<Static>` writes the
// transcript straight into the terminal scrollback (it is never re-rendered), so
// emptying the cell array on `/clear` does NOT erase what is already on screen —
// only wiping the terminal does. Ink repaints its (now empty) frame on top.
export const CLEAR_SCREEN = "\x1B[2J\x1B[3J\x1B[H"

export function clearTerminal(): void {
  if (process.stdout.isTTY) process.stdout.write(CLEAR_SCREEN)
}

/** Position of the user message at `index` among all user messages: its 1-based
 * `pos`, the `total` user-message count, and how many `later` ones follow it.
 * Drives the backtrack/edit status line. */
export function userMessageStats(
  cells: { kind: string }[],
  index: number
): { pos: number; total: number; later: number } {
  let total = 0
  let pos = 0
  cells.forEach((c, i) => {
    if (c.kind === "user") {
      total++
      if (i === index) pos = total
    }
  })
  return { pos, total, later: total - pos }
}

/** Read a theme config file, or null when it doesn't exist / can't be read. */
export function readThemeFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

/** Last path segment of `p` (project folder name), tolerant of either slash
 * style and trailing separators. Feeds the dynamic terminal title. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : p
}
