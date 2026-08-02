/**
 * Geometry helpers for the terminal tab strip's overflow affordances.
 *
 * Pure and unit-testable on their own because jsdom reports every element as
 * zero-sized: measuring is the component's job, deciding what the measurements
 * mean is this module's.
 */

/** A tab's horizontal extent in the strip's scroll coordinate space. */
export interface TabRect {
  id: string
  left: number
  right: number
}

/** Visible window of the scroll container, in the same coordinate space. */
export interface ContainerRect {
  left: number
  right: number
}

/**
 * Ids of tabs that are not *fully* inside the visible window.
 *
 * Partial visibility counts as hidden: a half-clipped tab is exactly the case
 * where the user cannot read its title and needs the overflow menu.
 */
export function hiddenTabIds(container: ContainerRect, tabs: TabRect[]): string[] {
  // A zero-width container means "not measured yet" (jsdom, or a strip that has
  // not been laid out). Claiming everything is hidden would flash the overflow
  // menu on every mount.
  if (container.right <= container.left) return []
  return tabs
    .filter((tab) => tab.left < container.left - 0.5 || tab.right > container.right + 0.5)
    .map((tab) => tab.id)
}

/** Which edge fades to paint, given the container's scroll state. */
export function overflowEdges(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number
): { start: boolean; end: boolean } {
  if (clientWidth <= 0 || scrollWidth <= clientWidth) return { start: false, end: false }
  return {
    start: scrollLeft > 0.5,
    // Sub-pixel rounding leaves a fraction of a pixel of "scrollable" width at
    // the end of a fully-scrolled strip; 1px of slack keeps the fade off.
    end: scrollLeft + clientWidth < scrollWidth - 1,
  }
}
