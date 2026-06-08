// Pure occlusion math for the desktop overlay. Seam for an occlusion-aware
// pause: when the pet's box is fully covered by another window, the overlay can
// stop animating. The live wiring to the real window-surface API (Facet A's
// `pet_window_get_surfaces`) is deferred; this keeps the geometry tested and
// ready. A "surface" here is any window rectangle in the same physical-px space.

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
