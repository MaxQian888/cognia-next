/**
 * Row budget for the modal overlay lists (`/model`, `/provider`, `/mcp`,
 * `/agents`, …). A long list must SCROLL so the highlighted row stays on
 * screen; if the widget is instead allowed to grow taller than the terminal,
 * the layout overflows, the list gets squeezed, and the highlighted row is
 * clipped — the "cursor disappears when I scroll down" bug.
 *
 * `windowList` treats the value returned here as the number of ITEM rows, but
 * the widget also draws chrome around those items, and other regions share the
 * same screen. So we reserve, and hand the list only what actually fits:
 *
 *   - {@link OVERLAY_CHROME_ROWS} — the list widget's own frame: the rounded
 *     border (2) + the title line (1) + BOTH "↑/↓ N more" scroll-hint rows (2,
 *     rendered ONLY while scrolling — the rows the old budget forgot) + the
 *     footer key-hint (1) = 6.
 *   - {@link OVERLAY_BOTTOM_ROWS} — the persistent bottom region beneath the
 *     overlay: the in-flight status line + mascot + footer identity line. The
 *     composer is hidden while an overlay is open, and the status line is empty
 *     when idle, so 3 covers the worst realistic idle case (mascot + footer +
 *     a lingering background-run chip).
 *   - {@link OVERLAY_BANNER_ROWS} — fullscreen only: the FIXED top banner stays
 *     on screen above the overlay (7 lines). In scrollback mode the banner
 *     scrolls away, so it costs nothing.
 *   - {@link OVERLAY_SLACK_ROWS} — one row of headroom for a searchable list's
 *     🔎 row / the transcript's "scrolled up" hint, which appear situationally.
 *
 * Floors at 3 so a tiny terminal still shows a usable (if cramped) list.
 */
export const OVERLAY_CHROME_ROWS = 6
export const OVERLAY_BOTTOM_ROWS = 3
export const OVERLAY_BANNER_ROWS = 7
export const OVERLAY_SLACK_ROWS = 1

/** Minimum item rows shown even on a very short terminal. */
export const OVERLAY_MIN_ROWS = 3

/**
 * How many ITEM rows the overlay list may show for a terminal `rows` tall,
 * given the effective layout (`fullscreen` pins the banner on-screen).
 */
export function overlayListRows(rows: number, fullscreen: boolean): number {
  const reserve =
    OVERLAY_CHROME_ROWS +
    OVERLAY_BOTTOM_ROWS +
    OVERLAY_SLACK_ROWS +
    (fullscreen ? OVERLAY_BANNER_ROWS : 0)
  return Math.max(OVERLAY_MIN_ROWS, rows - reserve)
}

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
 * Kept separate from {@link overlayListRows} (rather than widening it) because
 * that reserve is shared by ~20 other overlays; this only adjusts the one panel
 * whose chrome is taller.
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
    rows += Math.max(1, Math.ceil(line.length / width))
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
