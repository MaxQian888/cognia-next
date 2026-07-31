// Pure occlusion math for the desktop overlay. Seam for an occlusion-aware
// pause: when the pet's box is fully covered by another window, the overlay can
// stop animating. A "surface" here is any window rectangle in the same
// physical-px space.
//
// WHY THIS STAYS UNWIRED (2026-07 audit verdict): the pet window is
// always-on-top, so geometric containment by another window is a false
// positive in the single most common case — any maximized window "contains"
// the pet box while the pet visibly floats over it. Wiring this to
// `pet_window_get_surfaces` (which now returns visible top-edge SEGMENTS, not
// full rects, precisely because of z-order trimming) would pause the pet
// almost permanently. A correct occlusion pause needs a native z-order-aware
// signal scoped to windows ABOVE the topmost band (fullscreen-exclusive apps);
// until the platform exposes one, `pet://suspend` (native hide) and
// `document.hidden` cover the real power cases. The math stays tested so a
// future native signal can consume it as-is.

export interface OcclusionRect {
  x: number
  y: number
  width: number
  height: number
}

/** True when `outer` fully contains `inner`. */
export function rectContains(outer: OcclusionRect, inner: OcclusionRect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  )
}

/**
 * True when any single surface fully covers the pet box. Without OS z-order we
 * treat full geometric containment by another window as "occluded" — a
 * conservative heuristic suitable for pausing idle micro-motion.
 */
export function isFullyOccluded(petRect: OcclusionRect, surfaces: OcclusionRect[]): boolean {
  return surfaces.some((s) => rectContains(s, petRect))
}
