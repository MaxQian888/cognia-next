// Pure ballistic stepper for the drag-throw physics: gravity fall with
// diminishing ground bounces, wall bounces, and ground friction until the
// window settles. All units are physical px / seconds; the caller owns the
// clock and feeds frame deltas.

/** Mutable physics snapshot (window top-left position + velocity). */
export interface BallisticState {
  x: number
  y: number
  /** Velocity, px/s. */
  vx: number
  vy: number
  /** True once the window rests on the ground with negligible speed. */
  settled: boolean
}

export interface BallisticParams {
  /** Downward acceleration, px/s². */
  gravity: number
  /** Window-top Y of the resting ground line (see `resolveGroundTop`). */
  groundY: number
  /** Bounce energy retention, 0..1. */
  restitution: number
  /** Ground horizontal-velocity decay rate, 1/s. */
  groundFriction: number
  /** Horizontal window-position bounds (see `walkBoundsX`). */
  minX: number
  maxX: number
}

/** Defaults shared by the overlay hook and the tests. */
export const BALLISTIC_DEFAULTS = {
  gravity: 2800,
  restitution: 0.35,
  groundFriction: 6,
} as const

/** Below this speed (px/s) on the ground the window counts as settled. */
export const SETTLE_SPEED = 40

/** Frame deltas are clamped so a long stall can't tunnel through the floor. */
const MAX_STEP_SEC = 1 / 15

/** Advance the ballistic state by `dtMs`. Returns a new state (input unchanged). */
export function stepBallistic(
  state: BallisticState,
  dtMs: number,
  params: BallisticParams
): BallisticState {
  if (state.settled || dtMs <= 0) return state
  const dt = Math.min(dtMs / 1000, MAX_STEP_SEC)
  let { x, y, vx, vy } = state

  vy += params.gravity * dt
  x += vx * dt
  y += vy * dt

  // Wall bounce keeps the window on-monitor.
  if (x < params.minX) {
    x = params.minX
    vx = Math.abs(vx) * params.restitution
  } else if (x > params.maxX) {
    x = params.maxX
    vx = -Math.abs(vx) * params.restitution
  }

  let settled = false
  if (y >= params.groundY) {
    y = params.groundY
    if (vy > SETTLE_SPEED / params.restitution) {
      // Energetic impact → diminishing bounce.
      vy = -vy * params.restitution
    } else {
      vy = 0
    }
    // Slide friction while touching the ground.
    vx *= Math.max(0, 1 - params.groundFriction * dt)
    settled = vy === 0 && Math.abs(vx) < SETTLE_SPEED
    if (settled) vx = 0
  }

  return { x, y, vx, vy, settled }
}
