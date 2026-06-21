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

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
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

  // Staggered spring entrance — newly streamed cards/rows settle in with a
  // little bounce instead of a flat fade. `speed` scales the perceived pace by
  // adjusting damping (lower speed ⇒ slower settle).
  const delay = Math.min(Math.max(index, 0), 6) * 0.03

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay,
        type: "spring",
        stiffness: 320,
        damping: 30 / Math.max(speed, 0.25),
        opacity: { duration: 0.18 * speed, ease: "easeOut", delay },
      }}
    >
      {children}
    </motion.div>
  )
}

export interface MotionCollapseProps {
  /** When true the body is shown (and animates in); false animates it out. */
  open: boolean
  children: ReactNode
  className?: string
}

/**
 * Unified expand/collapse for the agent-flow surfaces — a gentle spring on
 * height + opacity so the tool rows, the activity group, and the sub-agent
 * rows all reveal their bodies the same way. Collapses to a plain show/hide
 * when motion is reduced (OS hint or user opt-in).
 *
 * The spring is tuned for low overshoot (height clipping under `overflow:
 * hidden` would otherwise flash), giving a crisp-but-soft settle.
 */
export function MotionCollapse({ open, children, className }: MotionCollapseProps) {
  const { reduce, speed } = useFlowMotion()

  if (reduce) {
    return open ? <div className={className}>{children}</div> : null
  }

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="collapse-body"
          className={className}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{
            type: "spring",
            stiffness: 340,
            damping: 34 / Math.max(speed, 0.25),
            opacity: { duration: 0.16 * speed, ease: "easeOut" },
          }}
          style={{ overflow: "hidden" }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export interface MotionStatusSwapProps {
  /** Changing this key crossfades the old glyph out and the new one in. */
  swapKey: string
  children: ReactNode
  className?: string
}

/**
 * Crossfade a small status glyph when it changes (e.g. running → done). Uses
 * `mode="wait"` so the outgoing glyph fades before the incoming one scales in,
 * avoiding a double-glyph flash. Plain passthrough when motion is reduced.
 */
export function MotionStatusSwap({ swapKey, children, className }: MotionStatusSwapProps) {
  const { reduce, speed } = useFlowMotion()

  if (reduce) {
    return <span className={className}>{children}</span>
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={swapKey}
        className={className}
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.6 }}
        transition={{ duration: 0.14 * speed, ease: "easeOut" }}
        style={{ display: "inline-flex" }}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  )
}
