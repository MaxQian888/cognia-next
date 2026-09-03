import { stringWidth } from "../markdown/width"

/** Worst-case list chrome: border, title, two scroll hints, and footer. */
export const OVERLAY_CHROME_ROWS = 6

/** Minimum item rows shown even on a very short terminal. */
export const OVERLAY_MIN_ROWS = 1

/**
 * Rows the unified `/logs` panel draws BEYOND {@link OVERLAY_CHROME_ROWS}:
 *
 *   - the channel-chips line (1) — `mcp 128 · agent 12 · sidecar 268`
 *   - the filter line (1)
 *   - a SECOND footer row (1) — the panel has ten bindings, and `OverlayFooter`
 *     is a plain `<Text>`, so cramming them onto one row lets Ink WRAP it. A
 *     wrapped footer silently eats an item row, which is exactly the
 *     clipped-cursor bug this module exists to prevent. Two rows, both
 *     reserved, is the fix; `log-model.ts` pins each row's length.
 */
export const LOG_PANEL_EXTRA_ROWS = 3

/**
 * Item rows for the `/logs` panel, given the shared overlay budget.
 *
 * The parent already supplies item rows derived from its measured viewport;
 * this only removes the log panel's additional local chrome.
 */
export function logPanelItemRows(overlayRows: number): number {
  return Math.max(OVERLAY_MIN_ROWS, overlayRows - LOG_PANEL_EXTRA_ROWS)
}

/**
 * How many terminal rows one list label occupies at `width`.
 *
 * The row budget above counts ITEMS, which silently assumes every item is one
 * row. A long tool name, an executable path or an install-command line wraps,
 * so on a narrow terminal a "10 item" window can draw 16 rows — pushing the
 * highlighted row off screen, the exact clipping the budget exists to prevent.
 *
 * Counts explicit newlines too, so a two-line entry costs two rows before
 * wrapping is even considered.
 */
export function wrappedRows(label: string, width: number): number {
  if (width <= 0) return 1
  let rows = 0
  for (const line of label.split("\n")) {
    rows += Math.max(1, Math.ceil(stringWidth(line) / width))
  }
  return Math.max(1, rows)
}

export interface WrappedWindow {
  /** First visible item index. */
  start: number
  /** Item count in the window (`start + count` is the exclusive end). */
  count: number
  /** Items hidden above / below, for the scroll hints. */
  above: number
  below: number
}

/**
 * Window a list by WRAPPED ROWS rather than item count, keeping `index` visible.
 *
 * Grows outward from the selected item — down first, then up — so the selection
 * stays put while the surrounding context fills whatever rows remain. Always
 * includes the selected item, even when it alone exceeds the budget: showing a
 * clipped selection beats showing none.
 */
export function windowByWrappedRows(
  labels: string[],
  index: number,
  rowBudget: number,
  width: number
): WrappedWindow {
  if (labels.length === 0) return { start: 0, count: 0, above: 0, below: 0 }
  const clamped = Math.min(Math.max(index, 0), labels.length - 1)
  const cost = labels.map((label) => wrappedRows(label, width))
  const budget = Math.max(1, rowBudget)
  let start = clamped
  let end = clamped + 1
  let used = cost[clamped]
  // Alternate down/up so the selection stays roughly centred rather than pinned
  // to an edge whenever the list is longer than the viewport.
  let grewDown = true
  let grewUp = true
  while ((grewDown || grewUp) && used < budget) {
    grewDown = false
    grewUp = false
    if (end < labels.length && used + cost[end] <= budget) {
      used += cost[end]
      end += 1
      grewDown = true
    }
    if (start > 0 && used + cost[start - 1] <= budget) {
      used += cost[start - 1]
      start -= 1
      grewUp = true
    }
  }
  return {
    start,
    count: end - start,
    above: start,
    below: labels.length - end,
  }
}

/**
 * Terminal width assumed when a panel is sized by a percentage, or not sized at
 * all, matching the fallback every other TUI renderer uses.
 */
export const DEFAULT_PANEL_COLUMNS = 80

/**
 * The columns a panel's rows can actually spend, given its `width` prop.
 *
 * Panels take `number | string | undefined` so they can be laid out by Ink's
 * percentage widths, but a row that has to cut its own text needs a real
 * number to cut against. Production passes the terminal width. Everything else
 * falls back rather than measuring against a percentage string.
 */
export function panelColumns(width: number | string | undefined): number {
  return typeof width === "number" && width > 0 ? width : DEFAULT_PANEL_COLUMNS
}
