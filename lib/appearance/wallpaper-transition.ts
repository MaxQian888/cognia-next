/**
 * Which transition actually gets played, and the CSS values that express it.
 *
 * The requested transition is not always the one you get, and the two reasons
 * for that are worth naming because both were design decisions rather than
 * limitations someone forgot to fix:
 *
 *   1. REDUCED MOTION. Under `prefers-reduced-motion: reduce`, and while the
 *      user has left `respectReducedMotion` on, every transition collapses to
 *      an instant swap. Ken Burns in particular is continuous background
 *      motion, which is exactly what that media query exists to stop.
 *
 *   2. THE SCRIM. The legibility scrim and the second wallpaper layer both
 *      want the `::after` pseudo-element of the same elements. The scrim only
 *      appears for image wallpapers below 0.5 opacity, so rather than move a
 *      working scrim or portal real DOM into every scoped panel, a two-layer
 *      transition degrades to the one-layer `fade` while the scrim is up.
 *      That is why `fade` must never itself require two layers.
 *
 * Both degradations are REPORTED, not silent. The settings UI reads
 * `degradedBy` and says which one is in effect, because a user who picks
 * "Ken Burns" and sees an instant cut deserves better than wondering whether
 * the setting saved.
 */

import {
  clampTransitionMs,
  transitionNeedsTwoLayers,
  WALLPAPER_EASING_CSS,
  type WallpaperRotationSettings,
  type WallpaperSlideDirection,
  type WallpaperTransition,
} from "@/types/appearance/wallpaper-rotation"

/** Why the requested transition was not the one played. */
export type TransitionDegradation = "reduced-motion" | "scrim"

export interface TransitionPlanInput {
  rotation: Pick<
    WallpaperRotationSettings,
    "transition" | "transitionMs" | "easing" | "slideDirection" | "respectReducedMotion"
  >
  /** True when the legibility scrim currently occupies the second pseudo. */
  scrimActive: boolean
  /** True when the environment asks for reduced motion. */
  reducedMotion: boolean
}

export interface TransitionPlan {
  /** The transition that will actually run. */
  effective: WallpaperTransition
  /** Whether both wallpaper layers paint at once during the swap. */
  twoLayer: boolean
  durationMs: number
  easingCss: string
  slideDirection: WallpaperSlideDirection
  /** Null when the requested transition survived intact. */
  degradedBy: TransitionDegradation | null
}

/**
 * Resolve the requested transition against the current environment.
 *
 * Reduced motion is checked first and wins outright. A user who has asked the
 * platform for less motion should not be handed a fade just because the scrim
 * happened to be up.
 */
export function planTransition(input: TransitionPlanInput): TransitionPlan {
  const { rotation, scrimActive, reducedMotion } = input
  const easingCss = WALLPAPER_EASING_CSS[rotation.easing] ?? WALLPAPER_EASING_CSS.easeInOut
  const requested = rotation.transition

  if (reducedMotion && rotation.respectReducedMotion) {
    return {
      effective: "none",
      twoLayer: false,
      durationMs: 0,
      easingCss,
      slideDirection: rotation.slideDirection,
      degradedBy: "reduced-motion",
    }
  }

  const durationMs = clampTransitionMs(rotation.transitionMs)

  if (scrimActive && transitionNeedsTwoLayers(requested)) {
    return {
      effective: "fade",
      twoLayer: false,
      durationMs,
      easingCss,
      slideDirection: rotation.slideDirection,
      degradedBy: "scrim",
    }
  }

  return {
    effective: requested,
    twoLayer: transitionNeedsTwoLayers(requested),
    durationMs,
    easingCss,
    slideDirection: rotation.slideDirection,
    degradedBy: null,
  }
}

/**
 * The custom properties the two-layer wallpaper stack reads off `<body>`.
 *
 * `image` deliberately keeps its historical name and stays layer A, so the
 * live-preview writes the wallpaper settings panel makes during a slider drag
 * keep working untouched.
 */
export const TRANSITION_VARS = {
  imageA: "--app-bg-image",
  imageB: "--app-bg-image-b",
  durationMs: "--app-bg-transition-duration",
  easing: "--app-bg-transition-easing",
  /**
   * Where each layer sits while hidden. Written per advance rather than once,
   * because the same variable serves as a layer's entry position when it is
   * arriving and its exit position when it is leaving, and only the applier
   * knows which role a layer is playing at the moment it flips the phase.
   */
  transformA: "--app-bg-transform-a",
  transformB: "--app-bg-transform-b",
} as const

/** Body attributes the stack keys off. */
export const TRANSITION_ATTRS = {
  /** Which layer is currently showing: `"a"` or `"b"`. */
  phase: "data-bg-phase",
  /** The effective transition name, so CSS can select per-transition rules. */
  transition: "data-bg-transition",
} as const

export type BackgroundPhase = "a" | "b"

/** The layer that is NOT showing, which is where an incoming image is staged. */
export function inactivePhase(phase: BackgroundPhase): BackgroundPhase {
  return phase === "a" ? "b" : "a"
}

/** The CSS variable holding a given phase's image. */
export function imageVarFor(phase: BackgroundPhase): string {
  return phase === "a" ? TRANSITION_VARS.imageA : TRANSITION_VARS.imageB
}

/**
 * Start offset for the incoming layer under `slide`, as a pair of CSS lengths.
 *
 * Expressed in viewport units so the distance travelled is the same whatever
 * the panel size, and negated per direction so "left" means the incoming image
 * arrives FROM the right and travels leftwards, which is what the label reads
 * as to a user watching it.
 */
export function slideOffset(direction: WallpaperSlideDirection): { x: string; y: string } {
  switch (direction) {
    case "left":
      return { x: "8vw", y: "0" }
    case "right":
      return { x: "-8vw", y: "0" }
    case "up":
      return { x: "0", y: "8vh" }
    case "down":
      return { x: "0", y: "-8vh" }
  }
}
