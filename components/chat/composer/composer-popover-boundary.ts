/**
 * Where a popover that grows UP out of the composer is allowed to go.
 *
 * The slash / `@` / `!` / `#` completion panel and the template-parameter
 * popover are portalled to `<body>`, so Radix (floating-ui) clips them against
 * the viewport only. On a phone with the keyboard open the space above the
 * composer is short, and the panel's natural height (search row + a 320px list
 * + footer) ran off the top of the screen, over the app header and behind the
 * status bar.
 *
 * The bound is the composer's nearest CLIPPING ancestor: the first element
 * above the composer root whose `overflow-y` is not `visible`. That is the
 * region the conversation actually occupies (below the app header, above the
 * keyboard) in both placements:
 *
 * - docked: the chat pane's column, which owns the area between the header and
 *   the composer;
 * - hero: the welcome page's scroll container.
 *
 * floating-ui intersects that element with the visual viewport, so the panel
 * also stays above an overlaying keyboard. The panel then takes its height
 * from `--radix-popover-content-available-height` and scrolls inside.
 *
 * `null` (no clipping ancestor, e.g. a bare test mount) keeps Radix's default:
 * the viewport.
 */

/** Marker on the composer's outermost element (`Composer`). */
export const COMPOSER_ROOT_ATTRIBUTE = "data-composer-root"

/** Breathing room between the panel and the boundary's edges, in px. */
export const COMPOSER_POPOVER_COLLISION_PADDING = 8

/**
 * Tailwind classes that cap a composer popover at the space Radix measured
 * for it and stack its rows so a scrollable list can shrink into that cap.
 */
export const COMPOSER_POPOVER_FIT_CLASS =
  "flex max-h-[var(--radix-popover-content-available-height)] flex-col"

export function resolveComposerPopoverBoundary(anchor: Element | null): Element | null {
  if (!anchor || typeof getComputedStyle !== "function") return null
  const root = anchor.closest(`[${COMPOSER_ROOT_ATTRIBUTE}]`) ?? anchor
  const doc = root.ownerDocument
  let node = root.parentElement
  while (node && node !== doc.body && node !== doc.documentElement) {
    const style = getComputedStyle(node)
    // `overflowY` is the longhand a browser always resolves; the shorthand is
    // the fallback for engines that leave the longhand empty.
    const overflowY = style.overflowY || style.overflow
    if (overflowY && overflowY !== "visible") return node
    node = node.parentElement
  }
  return null
}
