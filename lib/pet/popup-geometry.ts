// Pure placement for the desktop-pet click popup window (label "pet-popup").
// Given the sprite window's physical rectangle and the monitor work area, it
// resolves where the popup's top-left should sit: centered over the sprite and
// ABOVE it, flipping BELOW when there isn't room, always clamped fully
// on-screen. All inputs/outputs are PHYSICAL pixels — the same unit
// `pet_window_set_position` / `open_pet_popup` consume.

import { clampWalkTargetX, type WorkAreaRect } from "./overlay-geometry"

/** A physical-pixel rectangle (top-left + size). */
export interface PhysicalRect {
  x: number
  y: number
  width: number
  height: number
}

/** A resolved physical top-left screen position. */
export interface PopupPlacement {
  x: number
  y: number
}

/** Gap (physical px) kept between the popup and the sprite window. */
export const POPUP_GAP_PX = 12

/**
 * Initial LOGICAL size the popup window opens at. The popup's own
 * `ResizeObserver` fits the window to its card afterwards (size only, never
 * reposition), so these only need to be a sane estimate for the first placement
 * — generous enough that the panel + talk composer fit without a visible jump.
 */
export const POPUP_INITIAL_WIDTH = 330
export const POPUP_INITIAL_HEIGHT = 460

/**
 * Resolve the popup window's physical top-left.
 *
 * - Horizontally centered over the sprite, then clamped on-screen (reuses the
 *   wander X-clamp so the math matches the rest of the overlay).
 * - Placed above the sprite by `gapPx`; if its top would cross the work-area
 *   top, flipped to sit below the sprite instead.
 * - Finally clamped vertically so the whole popup stays inside the work area
 *   (covers the degenerate case where neither side fully fits — pins to an edge
 *   rather than going off-screen).
 */
export function resolvePopupPlacement(
  sprite: PhysicalRect,
  popupSize: { width: number; height: number },
  workArea: WorkAreaRect,
  gapPx: number = POPUP_GAP_PX
): PopupPlacement {
  const centerX = sprite.x + sprite.width / 2
  const x = clampWalkTargetX(centerX - popupSize.width / 2, workArea, popupSize.width)

  const above = sprite.y - gapPx - popupSize.height
  const below = sprite.y + sprite.height + gapPx
  let y = above >= workArea.y ? above : below

  const minY = workArea.y
  const maxY = Math.max(minY, workArea.y + workArea.height - popupSize.height)
  y = Math.min(maxY, Math.max(minY, y))

  return { x: Math.round(x), y: Math.round(y) }
}
