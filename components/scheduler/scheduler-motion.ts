/**
 * Shared `motion/react` variants for the scheduler dashboard views and the
 * dependency graph. Kept deliberately subtle (small offsets, short durations)
 * per the "克制精致" direction. Every consumer pairs these with
 * `useReducedMotion()` and calls {@link staticIf} so reduced-motion users get
 * an instant, non-animated render.
 */

import type { Variants } from "motion/react"

/** Container that staggers its children's entrance. */
export const listContainerVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
}

/** A list row: fade + tiny upward slide. */
export const listItemVariants: Variants = {
  hidden: { opacity: 0, y: 4 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18, ease: "easeOut" } },
}

/** Dashboard view crossfade (overview ↔ calendar ↔ timeline). */
export const viewSwitchVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18, ease: "easeOut" } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.12, ease: "easeIn" } },
}

/** A dependency-graph node mount: fade + scale-in. */
export const graphNodeVariants: Variants = {
  hidden: { opacity: 0, scale: 0.9 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.16, ease: "easeOut" } },
}

/**
 * When the user prefers reduced motion, collapse a variants object to a single
 * static state so no transition runs. Otherwise return the variants unchanged.
 */
export function staticIf(prefersReduced: boolean | null, variants: Variants): Variants {
  if (!prefersReduced) return variants
  const settled = variants.show ?? {}
  return { hidden: settled, show: settled, exit: settled }
}
