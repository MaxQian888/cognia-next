/**
 * A2UI Animation Utilities
 * Predefined animation variants and configuration helpers
 */

import type { Variants } from "motion/react"
import type {
  A2UIAnimationType,
  AnimationDirection,
  A2UIAnimationComponentDef,
} from "@/types/a2ui/animation"

/**
 * Predefined animation variants
 */
export const ANIMATION_VARIANTS: Record<
  A2UIAnimationType,
  (direction?: AnimationDirection) => Variants
> = {
  fadeIn: () => ({
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  }),
  fadeOut: () => ({
    initial: { opacity: 1 },
    animate: { opacity: 0 },
    exit: { opacity: 0 },
  }),
  slideIn: (direction = "up") => {
    const offsets = {
      up: { y: 30 },
      down: { y: -30 },
      left: { x: 30 },
      right: { x: -30 },
    }
    return {
      initial: { opacity: 0, ...offsets[direction] },
      animate: { opacity: 1, x: 0, y: 0 },
      exit: { opacity: 0, ...offsets[direction] },
    }
  },
  slideOut: (direction = "up") => {
    const offsets = {
      up: { y: -30 },
      down: { y: 30 },
      left: { x: -30 },
      right: { x: 30 },
    }
    return {
      initial: { opacity: 1, x: 0, y: 0 },
      animate: { opacity: 0, ...offsets[direction] },
      exit: { opacity: 0, ...offsets[direction] },
    }
  },
  scale: () => ({
    initial: { scale: 0, opacity: 0 },
    animate: { scale: 1, opacity: 1 },
    exit: { scale: 0, opacity: 0 },
  }),
  bounce: () => ({
    initial: { y: 0 },
    animate: {
      y: [0, -10, 0, -5, 0],
      transition: { duration: 0.6, ease: "easeOut" },
    },
  }),
  pulse: () => ({
    initial: { scale: 1 },
    animate: {
      scale: [1, 1.05, 1],
      transition: { duration: 1, repeat: Infinity, ease: "easeInOut" },
    },
  }),
  shake: () => ({
    initial: { x: 0 },
    animate: {
      x: [0, -5, 5, -5, 5, 0],
      transition: { duration: 0.5, ease: "easeInOut" },
    },
  }),
  highlight: () => ({
    initial: { backgroundColor: "transparent" },
    animate: {
      backgroundColor: ["transparent", "rgba(255, 215, 0, 0.3)", "transparent"],
      transition: { duration: 1, repeat: 2 },
    },
  }),
  none: () => ({
    initial: {},
    animate: {},
    exit: {},
  }),
}

/**
 * Get animation variants based on type and options
 */
export function getAnimationVariants(
  type: A2UIAnimationType,
  direction?: AnimationDirection,
  customAnimation?: A2UIAnimationComponentDef["customAnimation"]
): Variants {
  if (type === "none") {
    return ANIMATION_VARIANTS.none()
  }

  if (customAnimation) {
    return {
      initial: (customAnimation.initial || {}) as Variants["initial"],
      animate: (customAnimation.animate || {}) as Variants["animate"],
      exit: (customAnimation.exit || {}) as Variants["exit"],
    }
  }

  const variantFn = ANIMATION_VARIANTS[type] || ANIMATION_VARIANTS.fadeIn
  return variantFn(direction)
}

/**
 * Get transition configuration
 */
export function getTransitionConfig(
  duration: number = 0.5,
  delay: number = 0,
  repeat?: number | "infinite",
  customTransition?: Record<string, unknown>
): Record<string, unknown> {
  const base = {
    duration,
    delay,
    ease: "easeOut",
    ...customTransition,
  }

  if (repeat !== undefined) {
    return {
      ...base,
      repeat: repeat === "infinite" ? Infinity : repeat,
    }
  }

  return base
}
