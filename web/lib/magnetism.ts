/**
 * Geometry for the pointer companion (spec §6.7).
 *
 * Split out and pure because jsdom reports every rect as zero: a hook-level
 * test could never exercise this arithmetic, and the arithmetic is the part
 * that can be wrong in a way nobody notices until it is on a real screen. Same
 * split as `pickActive` in `use-section-progress.ts` and `indexFromScroll` in
 * `use-pinned-progress.ts`.
 */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface CompanionFrame {
  x: number
  y: number
  width: number
  height: number
  radius: number
}

/** The ring's size when it is not attached to anything. */
export const IDLE_SIZE = 26

/**
 * How far the ring may be pulled toward a target's centre, as a fraction of the
 * distance. A full pull (1) makes the ring ignore the pointer entirely, which
 * reads as the ring being broken rather than as attraction.
 */
export const PULL = 0.35

/**
 * Where the ring wants to be, given the pointer and whatever it is over.
 *
 * With no target the ring is a small circle centred on the pointer. Over a
 * target it takes the target's box — so the ring reads as having *latched onto
 * a control*, which is the affordance worth having — while still being pulled
 * only partway, so the pointer and the ring never fully separate.
 */
export function companionTarget(
  pointerX: number,
  pointerY: number,
  rect: Rect | null,
  cornerRadius = 0
): CompanionFrame {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { x: pointerX, y: pointerY, width: IDLE_SIZE, height: IDLE_SIZE, radius: IDLE_SIZE / 2 }
  }

  const centreX = rect.left + rect.width / 2
  const centreY = rect.top + rect.height / 2

  return {
    x: pointerX + (centreX - pointerX) * PULL,
    y: pointerY + (centreY - pointerY) * PULL,
    // Slightly proud of the control so the brackets frame it rather than
    // hiding its own border underneath. The radius grows by the same offset, so
    // a bracket stays concentric with the edge it is sighting.
    width: rect.width + 10,
    height: rect.height + 10,
    radius: cornerRadius > 0 ? cornerRadius + 5 : 0,
  }
}

/**
 * One eased step from `from` toward `to`.
 *
 * A per-frame fraction rather than a duration: the pointer target moves every
 * frame, so any fixed-duration tween would be restarted before it finished and
 * would never reach its target.
 */
export function approach(from: CompanionFrame, to: CompanionFrame, ease: number): CompanionFrame {
  const t = Math.min(Math.max(ease, 0), 1)
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    width: from.width + (to.width - from.width) * t,
    height: from.height + (to.height - from.height) * t,
    radius: from.radius + (to.radius - from.radius) * t,
  }
}

/** Whether two frames are close enough that another frame would not show. */
export function settled(a: CompanionFrame, b: CompanionFrame, epsilon = 0.1): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.width - b.width) < epsilon &&
    Math.abs(a.height - b.height) < epsilon &&
    Math.abs(a.radius - b.radius) < epsilon
  )
}
