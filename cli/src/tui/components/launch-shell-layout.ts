/**
 * Row budget for the launch shell — the frame every pre-chat phase draws in.
 *
 * Startup, connect, install and failure each used to return their own layout
 * tree. Three things went wrong with that:
 *
 *   - in fullscreen none of them set `height`, so the frame collapsed and
 *     re-expanded on every phase change and the terminal repainted the whole
 *     screen;
 *   - nothing bounded the body, so a long install log or a wrapped failure
 *     message pushed the actionable rows (the recovery list, "Esc to cancel")
 *     off the bottom — exactly where a user most needs them;
 *   - the banner is 7 rows, which on a 40×12 terminal leaves 5 for everything
 *     else, so the content the phase exists to show could not fit at all.
 *
 * This module answers "what fits" once, so the shell can drop the banner before
 * it drops the thing the user has to act on. Pure — no Ink, no measurement.
 */

/** Rows the bordered banner occupies (border 2 + 3 content + version line). */
export const LAUNCH_BANNER_ROWS = 7

/** Rows reserved for the shell's persistent hint line. */
export const LAUNCH_HINT_ROWS = 1

/** Never squeeze the body below this — a one-row body shows nothing useful. */
export const LAUNCH_MIN_BODY_ROWS = 3

export interface LaunchShellLayout {
  /** Whether the banner fits alongside a usable body. */
  showBanner: boolean
  /** Rows the body may use. */
  bodyRows: number
  /** Whether the hint line fits. */
  showHint: boolean
}

/**
 * Decide the launch shell's regions for a terminal `rows` tall.
 *
 * Priority order is deliberate and is the whole point: the BODY (what the user
 * must read or choose) outranks the hint, which outranks the banner. The banner
 * is decoration — dropping it to keep a recovery list on screen is always the
 * right trade, and the previous layout made the opposite one implicitly.
 */
export function launchShellLayout(rows: number, hasHint: boolean): LaunchShellLayout {
  const hintRows = hasHint ? LAUNCH_HINT_ROWS : 0
  const usable = Math.max(0, rows)
  // Can the banner AND a usable body both fit?
  const withBanner = usable - LAUNCH_BANNER_ROWS - hintRows
  if (withBanner >= LAUNCH_MIN_BODY_ROWS) {
    return { showBanner: true, bodyRows: withBanner, showHint: hasHint }
  }
  const withoutBanner = usable - hintRows
  if (withoutBanner >= LAUNCH_MIN_BODY_ROWS) {
    return { showBanner: false, bodyRows: withoutBanner, showHint: hasHint }
  }
  // Even the hint has to go before the body drops below the floor.
  return {
    showBanner: false,
    bodyRows: Math.max(LAUNCH_MIN_BODY_ROWS, usable),
    showHint: false,
  }
}

/**
 * Item rows a launch-phase list (the recovery choices, the folder picker) may
 * show, given the shell's body budget and the list's own chrome.
 *
 * Separate from `overlayListRows` because the launch shell reserves differently:
 * there is no composer, no transcript and no footer beneath it, so borrowing the
 * overlay's bottom reserve would leave rows unused on an already-tiny screen.
 */
export function launchListRows(bodyRows: number, chromeRows: number): number {
  return Math.max(1, bodyRows - chromeRows)
}

/**
 * Chrome a launch-phase list draws around its items: the rounded border (2),
 * both "↑/↓ N more" scroll hints (2), and the footer key-hint (1).
 *
 * Smaller than {@link OVERLAY_CHROME_ROWS}'s sibling reserve because a launch
 * phase has no title line above the list — the phase itself is the title.
 */
export const LAUNCH_LIST_CHROME_ROWS = 5
