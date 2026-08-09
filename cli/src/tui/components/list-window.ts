/**
 * Pure viewport math for keyboard lists (SelectList, file completer, slash
 * palette). A list with more entries than the available rows must scroll so the
 * highlighted row is always visible and the layout never overflows the terminal.
 *
 * Returns the visible slice `[start, end)` plus how many entries are hidden
 * `above` / `below` so the view can render compact "↑ N more" indicators.
 */
export interface ListWindow {
  start: number
  end: number
  above: number
  below: number
}

/** Clamp `value` into `[min, max]` (assumes `min <= max`). */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/**
 * Compute the visible window for a list of `length` rows with `selected`
 * highlighted, showing at most `maxRows` rows at once. The window scrolls to
 * keep `selected` on-screen, biased to centre it, and clamps at both ends so the
 * first/last rows are reachable.
 */
export function windowList(length: number, selected: number, maxRows: number): ListWindow {
  if (length <= 0 || maxRows <= 0) {
    return { start: 0, end: 0, above: 0, below: Math.max(0, length) }
  }
  if (length <= maxRows) {
    return { start: 0, end: length, above: 0, below: 0 }
  }
  const sel = clamp(selected, 0, length - 1)
  const half = Math.floor(maxRows / 2)
  const start = clamp(sel - half, 0, length - maxRows)
  const end = start + maxRows
  return { start, end, above: start, below: length - end }
}

/**
 * Window a list when the row budget must include the optional "more" rows.
 * Every hidden side costs one row, so items plus indicators never exceed the
 * supplied budget.
 */
export function windowListWithinRows(
  length: number,
  selected: number,
  rowBudget: number
): ListWindow {
  if (length <= 0 || rowBudget <= 0) return windowList(length, selected, 0)
  for (let visibleRows = Math.min(length, rowBudget); visibleRows >= 1; visibleRows -= 1) {
    const window = windowList(length, selected, visibleRows)
    const indicatorRows = Number(window.above > 0) + Number(window.below > 0)
    if (visibleRows + indicatorRows <= rowBudget) return window
  }
  return windowList(length, selected, 1)
}
