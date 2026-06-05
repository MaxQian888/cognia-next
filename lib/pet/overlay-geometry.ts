// Pure geometry for the desktop-pet overlay window. Single source of truth for
// the window-chrome margins that every open/resize path must agree on — the
// boot initializer, the settings toggle, the widget quick-menu toggle, and the
// overlay's own menu grow/restore (previously four hand-copied constants).

/** Extra width around the pet box so the quick menu / bubble have room. */
export const OVERLAY_CHROME_W = 96

/** Extra height around the pet box so the quick menu / bubble have room. */
export const OVERLAY_CHROME_H = 160

/** Logical overlay window size for a given pet render-box size. */
export function overlayWindowSize(petSize: number): { width: number; height: number } {
  return { width: petSize + OVERLAY_CHROME_W, height: petSize + OVERLAY_CHROME_H }
}

/**
 * Work-area rectangle of one monitor (taskbar excluded), in PHYSICAL pixels —
 * the same unit `pet_window_set_position` consumes. Reported by the Rust
 * `pet_window_get_work_area` command.
 */
export interface WorkAreaRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Window-top Y that rests the window bottom on the work-area bottom (the pet
 * is bottom-anchored inside the overlay, so its feet land on the taskbar
 * edge). Physical pixels.
 */
export function resolveGroundTop(workArea: WorkAreaRect, windowHeight: number): number {
  return workArea.y + workArea.height - windowHeight
}

/** Horizontal window-position bounds that keep the window fully on-monitor. */
export function walkBoundsX(
  workArea: WorkAreaRect,
  windowWidth: number
): { minX: number; maxX: number } {
  const minX = workArea.x
  return { minX, maxX: Math.max(minX, workArea.x + workArea.width - windowWidth) }
}

/** Clamp a wander target X into the on-monitor window-position bounds. */
export function clampWalkTargetX(
  targetX: number,
  workArea: WorkAreaRect,
  windowWidth: number
): number {
  const { minX, maxX } = walkBoundsX(workArea, windowWidth)
  return Math.min(maxX, Math.max(minX, targetX))
}

/** One pointer-position sample captured while dragging (physical px). */
export interface PointerSample {
  x: number
  y: number
  tMs: number
}

/** Samples older than this (relative to the newest) are ignored. */
export const VELOCITY_WINDOW_MS = 140

/** Release-speed ceiling in px/s — keeps a wild fling from teleporting. */
export const MAX_RELEASE_SPEED = 3200

/**
 * Releases slower than this are a placement, not a throw — the pet stays
 * where the user parked it instead of tumbling to the ground.
 */
export const MIN_THROW_SPEED = 700

/**
 * Release velocity (px/s) from the recent drag samples: newest minus the
 * oldest sample inside the window, over their time span. Fewer than two
 * usable samples (or a degenerate time span) means no throw.
 */
export function releaseVelocityFromSamples(samples: PointerSample[]): { vx: number; vy: number } {
  if (samples.length < 2) return { vx: 0, vy: 0 }
  const last = samples[samples.length - 1]
  const windowed = samples.filter((s) => last.tMs - s.tMs <= VELOCITY_WINDOW_MS)
  if (windowed.length < 2) return { vx: 0, vy: 0 }
  const first = windowed[0]
  const dtSec = (last.tMs - first.tMs) / 1000
  if (dtSec <= 0) return { vx: 0, vy: 0 }
  let vx = (last.x - first.x) / dtSec
  let vy = (last.y - first.y) / dtSec
  const speed = Math.hypot(vx, vy)
  if (speed > MAX_RELEASE_SPEED) {
    const k = MAX_RELEASE_SPEED / speed
    vx *= k
    vy *= k
  }
  return { vx, vy }
}
