"use client"

/**
 * Crossfade the body of a settings master/detail pane when the active panel
 * changes. `mode="wait"` fades the outgoing panel fully out before the
 * incoming one settles, so switching Subscription → Usage (or an Appearance /
 * Automation sub-panel) no longer pops instantly.
 *
 * Reuses `useFlowMotion` — the app-wide motion preference — so it collapses to
 * a plain wrapper when motion is reduced (OS hint or the user opt-in) and
 * scales the fade duration by the user's motion speed (the same multiplier the
 * global `--motion-duration-scale` var uses elsewhere). Mirrors
 * `MotionStatusSwap`, the glyph-level equivalent, for a consistent house feel.
 */

import { AnimatePresence, motion } from "motion/react"
import type { ReactNode } from "react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"

export interface PanelTransitionProps {
  /** Changing this key crossfades the outgoing panel out and the new one in. */
  activeKey: string
  children: ReactNode
  className?: string
}

export function PanelTransition({ activeKey, children, className }: PanelTransitionProps) {
  const { reduce, speed } = useFlowMotion()

  if (reduce) {
    return <div className={className}>{children}</div>
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={activeKey}
        className={className}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 6 }}
        transition={{ duration: 0.18 * speed, ease: "easeOut" }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
