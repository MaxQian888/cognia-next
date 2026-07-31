/**
 * Shared UI motion tokens — the single source of truth for the animation
 * curves used by the host *and* by plugins.
 *
 * These lived in the app (`lib/ui/motion.ts`) and 85 host modules import them
 * from there. They moved here rather than being copied because the dependency
 * has to point outward: this package must resolve with zero `@/` paths, so a
 * plugin can only share the host's motion vocabulary if the vocabulary itself
 * is the leaf. `lib/ui/motion.ts` is now a re-export shim over this file, which
 * is why the host call sites did not have to change.
 *
 * The values match the system spring used by iOS UIKit (cubic ease-out at
 * ~280 ms). They feel reasonable on Android and on desktop pointer input —
 * long enough to register but short enough that the surface stays responsive
 * under repeated interaction. The `MOBILE_*` export prefixes are retained
 * for backwards compatibility but the tokens are cross-surface.
 */

import type { Transition, Variants } from "motion/react"
import { useReducedMotion } from "motion/react"

/** iOS-style cubic-bezier ease. Use for translations, slides, sheets. */
export const MOBILE_EASE = [0.32, 0.72, 0, 1] as [number, number, number, number]

/** Durations in seconds (motion/react convention). */
export const MOBILE_DURATION = {
  fast: 0.18,
  normal: 0.28,
  slow: 0.42,
} as const

export type MobileDurationKey = keyof typeof MOBILE_DURATION

/**
 * Spring for surfaces that track a *selection* rather than play a timed
 * transition — a shared-layout indicator sliding between tab stops, a chip
 * settling into place, a press releasing.
 *
 * Duration-based easing is wrong for these: the distance varies with how far
 * the selection jumped, so a fixed duration reads sluggish for a neighbouring
 * tap and abrupt for a long one. The damping is deliberately high enough that
 * it settles without a visible bounce — the overshoot is what separates
 * "responsive" from "toy".
 */
export const MOBILE_SPRING: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 36,
  mass: 0.7,
}

/** Stagger spacing (seconds) for list enter animations. */
export const STAGGER_INTERVAL = 0.04

/** Standard list child variants: fade + slide-up 8px. */
export const STAGGER_CHILD: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8 },
}

/** Container with `staggerChildren` for use with motion.ul / motion.div + STAGGER_CHILD. */
export const STAGGER_CONTAINER: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: STAGGER_INTERVAL,
      delayChildren: 0.02,
    },
  },
}

/** Reusable enter transition built from the tokens. */
export function mobileTransition(durationKey: MobileDurationKey = "normal"): Transition {
  return {
    duration: MOBILE_DURATION[durationKey],
    ease: MOBILE_EASE,
  }
}

/**
 * Returns the supplied variants verbatim, or stripped versions that simply
 * snap to the `animate` state when the OS reports
 * `prefers-reduced-motion: reduce`. The helper lets callers write a single
 * variants object and trust the hook to do the right thing under the user's
 * accessibility preference.
 */
export function useReducedMotionVariants(variants: Variants): Variants {
  const reduce = useReducedMotion()
  if (!reduce) return variants
  const target = variants.animate
  return {
    initial: target ?? {},
    animate: target ?? {},
    exit: target ?? {},
  }
}

/**
 * Same idea as `useReducedMotionVariants` but for `Transition` objects.
 * Collapses any transition to `{ duration: 0 }` when reduced motion is on.
 */
export function useReducedMotionTransition(transition: Transition): Transition {
  const reduce = useReducedMotion()
  if (!reduce) return transition
  return { duration: 0 }
}
