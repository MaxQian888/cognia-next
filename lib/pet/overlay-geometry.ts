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

/**
 * A perchable "platform" — the top edge of a real desktop window the pet can
 * climb onto and walk along (Shimeji-style). Physical pixels; `y` is the
 * window's top edge, `x`/`width` its horizontal span. Reported by the Rust
 * `pet_window_get_surfaces` command.
 */
export interface Platform {
  x: number
  y: number
  width: number
}

/** Window-top Y that rests the pet's feet on a platform's top edge. */
export function resolvePlatformTop(platform: Platform, windowHeight: number): number {
  return platform.y - windowHeight
}

/** Horizontal window-position bounds while perched on a platform. */
export function platformBoundsX(
  platform: Platform,
  windowWidth: number
): { minX: number; maxX: number } {
  const minX = platform.x
  return { minX, maxX: Math.max(minX, platform.x + platform.width - windowWidth) }
}

/** True when the window's horizontal center sits over the platform span. */
export function isOnPlatform(
  windowX: number,
  windowWidth: number,
  platform: Platform,
  tolPx = 2
): boolean {
  const center = windowX + windowWidth / 2
  return center >= platform.x - tolPx && center <= platform.x + platform.width + tolPx
}

/** Two platforms are "the same" within a jitter tolerance (detect move/vanish). */
export function samePlatform(a: Platform | null, b: Platform | null, tolPx = 4): boolean {
  if (!a || !b) return a === b
  return (
    Math.abs(a.x - b.x) <= tolPx &&
    Math.abs(a.y - b.y) <= tolPx &&
    Math.abs(a.width - b.width) <= tolPx
  )
}

/**
 * The surface the pet lands on while falling from `windowY`: the highest surface
 * (smallest window-top) at or below `windowY` whose span contains the window
 * center, or the floor. Returns the resting window-top + the platform (null =
 * floor).
 */
export function nearestSupportBelow(
  windowY: number,
  windowX: number,
  windowWidth: number,
  windowHeight: number,
  platforms: Platform[],
  floorTop: number
): { top: number; platform: Platform | null } {
  const center = windowX + windowWidth / 2
  let bestTop = floorTop
  let bestPlatform: Platform | null = null
  for (const p of platforms) {
    const top = resolvePlatformTop(p, windowHeight)
    if (top < windowY) continue // above the pet → not a landing surface
    if (center < p.x || center > p.x + p.width) continue
    if (top < bestTop) {
      bestTop = top
      bestPlatform = p
    }
  }
  return { top: bestTop, platform: bestPlatform }
}

/**
 * A platform the resting pet can hop UP onto: its top is above the current rest
 * (`currentTop`) by no more than `hopRisePx`, and its span contains the window
 * center. Picks the closest one above. Null when none is reachable.
 */
export function reachablePlatformAbove(
  currentTop: number,
  windowX: number,
  windowWidth: number,
  windowHeight: number,
  platforms: Platform[],
  hopRisePx: number
): Platform | null {
  const center = windowX + windowWidth / 2
  let best: Platform | null = null
  let bestTop = -Infinity
  for (const p of platforms) {
    const top = resolvePlatformTop(p, windowHeight)
    const rise = currentTop - top
    if (rise <= 0 || rise > hopRisePx) continue
    if (center < p.x || center > p.x + p.width) continue
    if (top > bestTop) {
      bestTop = top
      best = p
    }
  }
  return best
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
