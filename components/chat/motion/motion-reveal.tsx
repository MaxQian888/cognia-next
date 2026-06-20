"use client"

/**
 * Lightweight motion primitives for the agent-flow surfaces.
 *
 * `MotionReveal` plays a one-shot entrance (fade + small translateY) when a
 * card/row first mounts — newly streamed tool calls slide in instead of
 * popping. It is deliberately GPU-friendly (only `opacity` + `transform`, no
 * layout animation, no backdrop-filter) so a tool-dense reply doesn't pay a
 * per-frame compositing cost while scrolling — the same constraint the static
 * `Tool` card honours.
 *
 * Motion respects user preferences: it collapses to a plain wrapper when the
 * appearance `motion.reduce` flag is set OR the OS `prefers-reduced-motion`
 * hint is on, and scales duration by `motion.speed` (the same multiplier the
 * global `--motion-duration-scale` var uses elsewhere).
 */

import { motion, useReducedMotion } from "motion/react"
import type { ReactNode } from "react"

import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_MOTION } from "@/types/appearance"

export interface FlowMotion {
  /** True when all motion should be suppressed (user opt-in or OS hint). */
  reduce: boolean
  /** Duration multiplier (matches `--motion-duration-scale`). */
  speed: number
}

/** Resolve the active motion preference for the agent-flow surfaces. */
export function useFlowMotion(): FlowMotion {
  const osReduce = useReducedMotion()
  const motionPref = useSettingsStore((s) => s.settings?.motion)
  return {
    reduce: osReduce === true || (motionPref?.reduce ?? false),
    speed: motionPref?.speed ?? DEFAULT_MOTION.speed,
  }
}

export interface MotionRevealProps {
  children: ReactNode
  /** Stagger index — later items reveal slightly after earlier ones (capped). */
  index?: number
  className?: string
  /** Force-disable the animation regardless of preference. */
  disabled?: boolean
}

export function MotionReveal({ children, index = 0, className, disabled }: MotionRevealProps) {
  const { reduce, speed } = useFlowMotion()

  if (disabled || reduce) {
    return className ? <div className={className}>{children}</div> : <>{children}</>
  }

  const duration = 0.18 * speed
  const delay = Math.min(Math.max(index, 0), 6) * 0.03

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, delay, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  )
}
