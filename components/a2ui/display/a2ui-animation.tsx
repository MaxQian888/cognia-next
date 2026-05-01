"use client"

/**
 * A2UI Animation Component
 *
 * Provides animation capabilities within the A2UI system.
 * Supports predefined animations and custom animation configurations.
 */

import React, { memo, useMemo } from "react"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"
import type { A2UIComponentProps } from "@/types/a2ui/schema"
import type { A2UIAnimationComponentDef } from "@/types/a2ui/animation"
import { getAnimationVariants, getTransitionConfig } from "@/lib/a2ui/animation"

/**
 * A2UI Animation Component
 */
export const A2UIAnimation = memo(function A2UIAnimation({
  component,
  renderChild,
}: A2UIComponentProps) {
  const prefersReducedMotion = useReducedMotion()

  const animationComponent = component as A2UIAnimationComponentDef
  const {
    type = "fadeIn",
    direction,
    duration = 0.5,
    delay = 0,
    repeat,
    children,
    customAnimation,
    className,
  } = animationComponent

  // Get animation configuration
  const variants = useMemo(
    () => getAnimationVariants(type, direction, customAnimation),
    [type, direction, customAnimation]
  )

  const transition = useMemo(
    () =>
      getTransitionConfig(
        duration,
        delay,
        repeat,
        customAnimation?.transition as Record<string, unknown>
      ),
    [duration, delay, repeat, customAnimation?.transition]
  )

  // If user prefers reduced motion, skip animations
  const effectiveVariants = prefersReducedMotion
    ? { initial: variants.animate, animate: variants.animate, exit: variants.animate }
    : variants

  return (
    <motion.div
      className={cn("a2ui-animation", className)}
      variants={effectiveVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={transition}
    >
      {children?.map((childId) => (
        <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
      ))}
    </motion.div>
  )
})
