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
