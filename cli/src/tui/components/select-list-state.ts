/**
 * Pure selection-index math for the keyboard `SelectList` and any inline popup
 * (slash palette, file completer) that tracks its own highlighted row.
 */

/** Move a selection index by `delta`, wrapping at the list ends. */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (((current + delta) % length) + length) % length
}

/** Clamp an index into `[0, length)`. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(index, length - 1))
}
