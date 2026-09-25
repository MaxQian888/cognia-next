/**
 * The island's shape on its display — pure, so the geometry every
 * presentation lands on is pinned by tests rather than by screenshots.
 *
 * Two layouts:
 *
 *   - `notch`: a display with a camera housing whose width macOS reported.
 *     The island is drawn as the housing growing: compact and minimal live
 *     entirely in the housing strip, as "ears" either side of the camera,
 *     and the expanded card grows downward out of it. Nothing is drawn
 *     where the camera is, and nothing hangs below the menu bar over the
 *     frontmost app until the person expands it.
 *   - `flat`: every other display — no housing, or one whose width the OS
 *     did not report, where content cannot be placed beside a camera it
 *     cannot locate. A pill at the top edge that tucks into a sliver, with
 *     its content padded below any reported inset.
 */

import type { IslandGeometry } from "@/lib/fleet/types"

export type IslandLayout = "notch" | "flat"

/** What the card is presenting, in Live Activities vocabulary. */
export type IslandPresentation = "minimal" | "compact" | "expanded"

/** Flat pill width while compact or minimal (logical px). */
export const ISLAND_COLLAPSED_WIDTH = 420
/** Width of the expanded card in either layout, at least (logical px). */
export const ISLAND_EXPANDED_WIDTH = 560
/** Flat pill height (kept in lockstep with the `h-11` pill button). */
export const ISLAND_PILL_HEIGHT = 44
/** Each ear beside the housing while minimal: a status dot, a count. */
export const ISLAND_NOTCH_MINIMAL_EAR = 36
/** Each ear beside the housing while compact: a name on one side, a state on the other. */
export const ISLAND_NOTCH_COMPACT_EAR = 110

export function islandLayout(
  geometry: Pick<IslandGeometry, "topInset" | "notchWidth">
): IslandLayout {
  return geometry.topInset > 0 && geometry.notchWidth > 0 ? "notch" : "flat"
}

/**
 * Card width for a presentation.
 *
 * `hasActivity` only matters for a minimal notch island: with nothing running
 * it is exactly the housing — black on black, invisible — and still the hover
 * target that brings it back out.
 */
export function islandWidth(
  layout: IslandLayout,
  presentation: IslandPresentation,
  notchWidth: number,
  hasActivity: boolean
): number {
  if (layout === "flat") {
    return presentation === "expanded" ? ISLAND_EXPANDED_WIDTH : ISLAND_COLLAPSED_WIDTH
  }
  switch (presentation) {
    case "minimal":
      return notchWidth + (hasActivity ? 2 * ISLAND_NOTCH_MINIMAL_EAR : 0)
    case "compact":
      return Math.max(ISLAND_COLLAPSED_WIDTH, notchWidth + 2 * ISLAND_NOTCH_COMPACT_EAR)
    case "expanded":
      return Math.max(ISLAND_EXPANDED_WIDTH, notchWidth + 2 * ISLAND_NOTCH_COMPACT_EAR)
  }
}

/**
 * The CONTENT height reported to the window (logical px); the window adds the
 * display's top inset itself.
 *
 * `measured` is the laid-out height of the header plus the list. In the notch
 * layout the header IS the housing strip, so only what hangs below it counts,
 * and a collapsed island counts nothing — it lives in the strip. In the flat
 * layout the collapsed pill is a fixed height and the expanded card is at
 * least that tall.
 */
export function islandContentHeight(
  layout: IslandLayout,
  presentation: IslandPresentation,
  measured: number,
  topInset: number
): number {
  if (layout === "notch") {
    return presentation === "expanded" ? Math.max(0, measured - topInset) : 0
  }
  return presentation === "expanded" ? Math.max(ISLAND_PILL_HEIGHT, measured) : ISLAND_PILL_HEIGHT
}
