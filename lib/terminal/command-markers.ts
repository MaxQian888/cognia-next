/**
 * Command-marker helpers for the integrated terminal (1B).
 *
 * The shell-integration parser (OSC 633) emits `command_start` /
 * `command_end` events. `terminal-instance.tsx` registers an xterm
 * marker at the buffer line where each command begins and paints a
 * gutter decoration whose colour reflects the command's exit code.
 *
 * This module owns the *pure* bits — exit-code → colour mapping and the
 * "jump to previous/next command" line maths — so they can be unit
 * tested without an xterm instance.
 */

/** Decoration colour (sRGB hex) by exit state. Mirrors the history-rail dots. */
export function exitMarkerColor(exitCode: number | null): string {
  if (exitCode === null) return "#a1a1aa" // running / unknown — neutral
  return exitCode === 0 ? "#10b981" : "#ef4444" // emerald / red
}

/**
 * Largest marker line strictly above `ref`, or `null` when there is none.
 * Used by "jump to previous command": `ref` is the current viewport top.
 * `lines` need not be sorted.
 */
export function prevMarkerLine(lines: readonly number[], ref: number): number | null {
  let best: number | null = null
  for (const line of lines) {
    if (line < ref && (best === null || line > best)) best = line
  }
  return best
}

/**
 * Smallest marker line strictly below `ref`, or `null` when there is none.
 * Used by "jump to next command". `lines` need not be sorted.
 */
export function nextMarkerLine(lines: readonly number[], ref: number): number | null {
  let best: number | null = null
  for (const line of lines) {
    if (line > ref && (best === null || line < best)) best = line
  }
  return best
}
