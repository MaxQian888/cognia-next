// Wallpaper rotation ("carousel"), meaning the app background cycling through
// a playlist of wallpapers the user already owns, plus the transition played
// on every advance.
//
// Two things live here that are easy to conflate and must not be:
//
//   - ROTATION cycles the LOCAL gallery. It never touches the network.
//   - DAILY WALLPAPER (`./daily-wallpaper.ts`) fetches a NEW image from a
//     remote source. It feeds the gallery, and rotation then cycles the
//     result like any other wallpaper.
//
// Both can be on at once: the daily fetch lands a new image in the gallery,
// and rotation includes it on the next advance.
//
// Persistence rides on `AppSettings.background.rotation`, so the whole config
// travels with the existing backup/restore and settings-mirror pipelines. No
// new table.

/**
 * How one wallpaper gives way to the next.
 *
 * `none` is the historical behaviour, a bare CSS variable swap with the 200ms
 * opacity transition that already sits on the layer. Everything else is a
 * deliberate composition. See `lib/appearance/wallpaper-transition.ts` for how
 * each one is projected onto the two-layer stack.
 *
 * - `none`      instant swap.
 * - `fade`      the single layer dips to transparent, swaps, and returns.
 *               The only transition that needs one layer, which is why it is
 *               the fallback wherever the second layer is unavailable.
 * - `crossfade` outgoing and incoming are both painted, and the incoming
 *               fades up over the outgoing. The default.
 * - `dissolve`  a crossfade that also ramps blur through the midpoint, so the
 *               swap reads as a defocus rather than a wipe.
 * - `slide`     the incoming layer translates in from an edge.
 * - `zoom`      the incoming layer scales down into place from slightly
 *               over-sized, crossfading as it settles.
 * - `kenBurns`  a crossfade PLUS a slow continuous pan and scale that runs for
 *               the whole time a wallpaper is resting, not just during the
 *               swap. The only transition with an effect between advances.
 */
export type WallpaperTransition =
  "none" | "fade" | "crossfade" | "dissolve" | "slide" | "zoom" | "kenBurns"

export const WALLPAPER_TRANSITIONS: readonly WallpaperTransition[] = [
  "none",
  "fade",
  "crossfade",
  "dissolve",
  "slide",
  "zoom",
  "kenBurns",
]

/** Direction the incoming layer travels for {@link WallpaperTransition} `slide`. */
export type WallpaperSlideDirection = "left" | "right" | "up" | "down"

export const WALLPAPER_SLIDE_DIRECTIONS: readonly WallpaperSlideDirection[] = [
  "left",
  "right",
  "up",
  "down",
]

/**
 * Easing applied to the transition. Deliberately a small named set rather than
 * a free-text `cubic-bezier`, because these are projected into a CSS variable
 * that a user-authored value could otherwise use to smuggle arbitrary CSS.
 */
export type WallpaperTransitionEasing = "linear" | "ease" | "easeIn" | "easeOut" | "easeInOut"

export const WALLPAPER_TRANSITION_EASINGS: readonly WallpaperTransitionEasing[] = [
  "linear",
  "ease",
  "easeIn",
  "easeOut",
  "easeInOut",
]

/** The CSS timing function each easing keyword resolves to. */
export const WALLPAPER_EASING_CSS: Record<WallpaperTransitionEasing, string> = {
  linear: "linear",
  ease: "ease",
  easeIn: "cubic-bezier(0.4, 0, 1, 1)",
  easeOut: "cubic-bezier(0, 0, 0.2, 1)",
  easeInOut: "cubic-bezier(0.4, 0, 0.2, 1)",
}

/** Play order through the playlist. */
export type WallpaperRotationOrder = "sequential" | "shuffle"

export const WALLPAPER_ROTATION_ORDERS: readonly WallpaperRotationOrder[] = [
  "sequential",
  "shuffle",
]

/**
 * What causes an advance.
 *
 * `interval` is wall-clock elapsed time. `daily` advances once per local
 * calendar day, which is NOT the same as a 24h interval, because it lands on
 * the day boundary regardless of when the app was last open. A machine that
 * sleeps overnight still shows a new wallpaper in the morning. `launch`
 * advances once per app start and never again.
 */
export type WallpaperRotationTrigger = "interval" | "daily" | "launch"

export const WALLPAPER_ROTATION_TRIGGERS: readonly WallpaperRotationTrigger[] = [
  "interval",
  "daily",
  "launch",
]

/** Interval presets offered in the UI, in milliseconds. */
export const WALLPAPER_INTERVAL_PRESETS: readonly number[] = [
  60_000, // 1 minute
  5 * 60_000, // 5 minutes
  15 * 60_000, // 15 minutes
  30 * 60_000, // 30 minutes
  60 * 60_000, // 1 hour
  6 * 60 * 60_000, // 6 hours
  12 * 60 * 60_000, // 12 hours
]

/**
 * Floor on the interval. Every advance persists `lastAdvancedAt` through the
 * settings funnel, which is one Dexie write, so a 5-second carousel would be a
 * write loop. 30s is low enough to demo a transition and high enough to be
 * free.
 */
export const MIN_ROTATION_INTERVAL_MS = 30_000
export const MAX_ROTATION_INTERVAL_MS = 7 * 24 * 60 * 60_000

/** Bounds on the transition duration. 0 is legal and means "instant". */
export const MIN_TRANSITION_MS = 0
export const MAX_TRANSITION_MS = 5_000

export interface WallpaperRotationSettings {
  enabled: boolean
  /**
   * Wallpaper ids, in play order, drawn from the gallery (built-ins, plugin
   * wallpapers and user uploads alike).
   *
   * An EMPTY playlist means "every image wallpaper in the gallery", resolved
   * at advance time. That is deliberate. It keeps a freshly-fetched daily
   * wallpaper in the rotation without the user having to re-curate a list,
   * and it means deleting a wallpaper cannot strand the playlist on a dead id.
   */
  playlist: string[]
  order: WallpaperRotationOrder
  trigger: WallpaperRotationTrigger
  /** Only consulted when `trigger === "interval"`. Clamped on read. */
  intervalMs: number
  transition: WallpaperTransition
  transitionMs: number
  easing: WallpaperTransitionEasing
  slideDirection: WallpaperSlideDirection
  /**
   * Hold the timer while the document is hidden. On by default, because
   * advancing a wallpaper nobody is looking at burns a Dexie write and, on the
   * desktop host, decodes a full-resolution image for nothing.
   */
  pauseWhenHidden: boolean
  /**
   * Collapse to an instant swap under `prefers-reduced-motion: reduce`.
   *
   * On by default and separately togglable, because the two halves are
   * different asks. A user who reduces motion for vestibular reasons wants the
   * Ken Burns drift gone, but may still be fine with a plain crossfade.
   * Turning this OFF is an explicit "I know, keep the motion". The app never
   * makes that choice for them.
   */
  respectReducedMotion: boolean
  /**
   * Epoch-ms of the last advance. Written by the runtime, not the UI. Absent
   * until the first advance, which is what makes a freshly-enabled rotation
   * wait a full interval rather than firing immediately on mount.
   */
  lastAdvancedAt?: number
}

export const DEFAULT_WALLPAPER_ROTATION: WallpaperRotationSettings = {
  enabled: false,
  playlist: [],
  order: "sequential",
  trigger: "interval",
  intervalMs: 15 * 60_000,
  transition: "crossfade",
  transitionMs: 900,
  easing: "easeInOut",
  slideDirection: "left",
  pauseWhenHidden: true,
  respectReducedMotion: true,
}

/** Narrow an arbitrary value to a {@link WallpaperTransition}. */
export function isWallpaperTransition(value: unknown): value is WallpaperTransition {
  return WALLPAPER_TRANSITIONS.includes(value as WallpaperTransition)
}

/** Narrow an arbitrary value to a {@link WallpaperRotationOrder}. */
export function isWallpaperRotationOrder(value: unknown): value is WallpaperRotationOrder {
  return WALLPAPER_ROTATION_ORDERS.includes(value as WallpaperRotationOrder)
}

/** Narrow an arbitrary value to a {@link WallpaperRotationTrigger}. */
export function isWallpaperRotationTrigger(value: unknown): value is WallpaperRotationTrigger {
  return WALLPAPER_ROTATION_TRIGGERS.includes(value as WallpaperRotationTrigger)
}

/**
 * Whether a transition needs BOTH layers painted at once.
 *
 * `fade` deliberately does not. It is the degradation target wherever the
 * second layer cannot be had (see `wallpaper-transition.ts`), so it must never
 * itself require one.
 */
export function transitionNeedsTwoLayers(transition: WallpaperTransition): boolean {
  return (
    transition === "crossfade" ||
    transition === "dissolve" ||
    transition === "slide" ||
    transition === "zoom" ||
    transition === "kenBurns"
  )
}

/** Clamp an interval into the supported range. */
export function clampRotationInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_WALLPAPER_ROTATION.intervalMs
  return Math.min(MAX_ROTATION_INTERVAL_MS, Math.max(MIN_ROTATION_INTERVAL_MS, Math.round(ms)))
}

/** Clamp a transition duration into the supported range. */
export function clampTransitionMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_WALLPAPER_ROTATION.transitionMs
  return Math.min(MAX_TRANSITION_MS, Math.max(MIN_TRANSITION_MS, Math.round(ms)))
}
