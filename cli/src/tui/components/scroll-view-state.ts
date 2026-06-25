/**
 * Pure scroll-viewport math for the fullscreen layout's middle pane.
 *
 * The viewport shows a window of `viewportHeight` rows onto content that is
 * `contentHeight` rows tall. `ScrollIntent` is the user's *intent* (a raw scroll
 * offset + a "stick to bottom" flag); the EFFECTIVE offset is always derived
 * from the live measured heights so a window resize or new streamed output never
 * leaves the offset stale or out of range. Keeping this pure (no refs, no React)
 * makes every clamp/page/stick rule unit-testable.
 *
 * Convention: `top` is the number of content rows hidden ABOVE the viewport
 * (0 = scrolled to the very top). `stick` pins the view to the bottom so new
 * output stays visible — the default, and what every "follow the latest" agent
 * transcript wants.
 */

export interface ScrollIntent {
  /** Rows hidden above the viewport when not sticking. */
  top: number
  /** Pin to the bottom (follow new output). */
  stick: boolean
}

/** The initial intent: pinned to the bottom. */
export const INITIAL_SCROLL: ScrollIntent = { top: 0, stick: true }

/** Max rows that can be hidden above the viewport (0 when content fits). */
export function maxScroll(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, Math.floor(contentHeight) - Math.floor(viewportHeight))
}

/** Clamp a raw offset into `[0, maxScroll]`. */
export function clampTop(top: number, contentHeight: number, viewportHeight: number): number {
  const max = maxScroll(contentHeight, viewportHeight)
  if (!Number.isFinite(top) || top < 0) return 0
  return Math.min(Math.floor(top), max)
}

/**
 * The offset to actually render with: `maxScroll` while sticking, else the
 * clamped raw offset. Always in range for the current measured heights.
 */
export function effectiveTop(
  intent: ScrollIntent,
  contentHeight: number,
  viewportHeight: number
): number {
  if (intent.stick) return maxScroll(contentHeight, viewportHeight)
  return clampTop(intent.top, contentHeight, viewportHeight)
}

/** Is the view currently pinned to (or scrolled to) the bottom? */
export function atBottom(
  intent: ScrollIntent,
  contentHeight: number,
  viewportHeight: number
): boolean {
  return (
    effectiveTop(intent, contentHeight, viewportHeight) >= maxScroll(contentHeight, viewportHeight)
  )
}

/**
 * Scroll by `delta` rows from the current effective offset. `delta > 0` moves
 * DOWN (toward the bottom / newer content); `delta < 0` moves UP. Re-engages
 * `stick` automatically once the bottom is reached so subsequent output follows.
 */
export function scrollByLines(
  intent: ScrollIntent,
  delta: number,
  contentHeight: number,
  viewportHeight: number
): ScrollIntent {
  const max = maxScroll(contentHeight, viewportHeight)
  const next = clampTop(
    effectiveTop(intent, contentHeight, viewportHeight) + delta,
    contentHeight,
    viewportHeight
  )
  return { top: next, stick: next >= max }
}

/** Page-scroll: one viewport-worth minus a row of overlap (like `less`). */
export function scrollPage(
  intent: ScrollIntent,
  direction: "up" | "down",
  contentHeight: number,
  viewportHeight: number
): ScrollIntent {
  const step = Math.max(1, Math.floor(viewportHeight) - 1)
  return scrollByLines(intent, direction === "down" ? step : -step, contentHeight, viewportHeight)
}

/** Jump to the very top (and stop following the bottom). */
export function scrollToTop(): ScrollIntent {
  return { top: 0, stick: false }
}

/**
 * Fraction of the viewport kept ABOVE a jumped-to row, so a find match lands
 * with a little context above it rather than flush against the top edge.
 */
export const SCROLL_TO_ROW_BIAS = 1 / 3

/**
 * Scroll so `targetRow` (a content-row index, 0 = first row) sits roughly
 * {@link SCROLL_TO_ROW_BIAS} of the way down the viewport, clamped into range.
 * Stops following the bottom (a jump is an explicit position). Degrades to the
 * top when sizes aren't measured yet (viewport 0 ⇒ no meaningful window), so a
 * jump never throws on the first commit or under the jsdom test mock.
 */
export function scrollToRow(
  targetRow: number,
  contentHeight: number,
  viewportHeight: number
): ScrollIntent {
  const row = Number.isFinite(targetRow) ? Math.max(0, Math.floor(targetRow)) : 0
  const lead = Math.floor(Math.max(0, Math.floor(viewportHeight)) * SCROLL_TO_ROW_BIAS)
  const top = clampTop(row - lead, contentHeight, viewportHeight)
  return { top, stick: false }
}

/** Jump to the bottom and re-engage follow mode. */
export function scrollToBottom(): ScrollIntent {
  return { top: 0, stick: true }
}

/** Rows hidden above / below the viewport — drives the scroll indicator. */
export function hiddenRows(
  intent: ScrollIntent,
  contentHeight: number,
  viewportHeight: number
): { above: number; below: number } {
  const top = effectiveTop(intent, contentHeight, viewportHeight)
  const max = maxScroll(contentHeight, viewportHeight)
  return { above: top, below: Math.max(0, max - top) }
}
