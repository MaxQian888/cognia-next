/**
 * Horizontal edge auto-scroll for the issue board.
 *
 * dnd-kit's built-in auto-scroll walks the scrollable ancestors of the active
 * draggable. On this board that chain is `column (overflow-y-auto)` →
 * `board (overflow-x-auto)`, and the vertical container wins — so dragging a
 * card toward the right edge scrolls the column it is leaving instead of the
 * board it is crossing. The board therefore pins dnd-kit's x-threshold to 0
 * (never activate horizontally) and owns the horizontal axis here.
 *
 * Kept pure and separate so the ramp is unit-tested without a DOM or a drag.
 */

/** Width of the hot zone at each edge of the board, in CSS pixels. */
export const BOARD_EDGE_SCROLL_ZONE_PX = 88

/** Fastest nudge, applied once the pointer reaches the very edge. */
export const BOARD_EDGE_SCROLL_MAX_PX = 22

/**
 * Collapse `-0` to `0`. `Math.ceil(0)` and `Math.min(0, …)` both hand back
 * `-0` once negated, and while `-0 === 0` is true, a function documented as
 * "returns 0 when there is nothing to do" should actually return 0 — a caller
 * using `Object.is` or a snapshot would otherwise see the wrong thing.
 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value
}

export interface BoardScrollBounds {
  left: number
  right: number
}

/**
 * How far to nudge the board this frame for a pointer at `clientX`.
 *
 * Negative scrolls left, positive right, 0 means the pointer is outside both
 * hot zones. The ramp is linear in how deep into the zone the pointer is, so
 * the board creeps at the zone boundary and moves decisively at the edge —
 * a constant speed makes precise drops near the edge almost impossible.
 *
 * A pointer past the edge entirely (dragged outside the board) clamps to the
 * maximum rather than accelerating without bound.
 */
export function boardEdgeScrollDelta(
  clientX: number,
  bounds: BoardScrollBounds,
  zone: number = BOARD_EDGE_SCROLL_ZONE_PX,
  max: number = BOARD_EDGE_SCROLL_MAX_PX
): number {
  if (zone <= 0 || bounds.right - bounds.left <= 0) return 0

  // A board narrower than two hot zones would have them overlap; halve them so
  // the two edges cannot both claim the same pointer position.
  const effectiveZone = Math.min(zone, (bounds.right - bounds.left) / 2)

  const leftEdge = bounds.left + effectiveZone
  if (clientX <= leftEdge) {
    const depth = Math.min(1, (leftEdge - clientX) / effectiveZone)
    return normalizeZero(-Math.ceil(depth * max))
  }

  const rightEdge = bounds.right - effectiveZone
  if (clientX >= rightEdge) {
    const depth = Math.min(1, (clientX - rightEdge) / effectiveZone)
    return normalizeZero(Math.ceil(depth * max))
  }

  return 0
}

/**
 * Clamp a proposed scroll delta to what the element can actually absorb, so a
 * drag parked at an edge stops issuing writes once the board is already at the
 * end. Returns 0 when there is nothing left to scroll.
 */
export function clampScrollDelta(
  delta: number,
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number
): number {
  if (delta < 0) return normalizeZero(-Math.min(-delta, scrollLeft))
  if (delta > 0) {
    return normalizeZero(Math.min(delta, Math.max(0, scrollWidth - clientWidth - scrollLeft)))
  }
  return 0
}
