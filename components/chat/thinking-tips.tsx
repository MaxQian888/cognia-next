"use client"

/**
 * `<ThinkingTips>` — a single rotating "did you know" tip surfaced beneath the
 * thinking indicator once the wait has run long enough (see `useThinkingPhase`
 * / `ChatThinkingIndicator`). Purely presentational: the parent owns the tip
 * list and the rotating `index`; this component just crossfades whichever tip
 * the index points at.
 *
 * Motion is gated by `useFlowMotion()` — reduced motion collapses the
 * crossfade to a plain swap (mirrors `MotionStatusSwap` in `motion-reveal`).
 */

import { AnimatePresence, motion } from "motion/react"
import { LightbulbIcon } from "lucide-react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { cn } from "@/lib/utils"

export interface ThinkingTipsProps {
  /** Curated tip strings (already localized by the parent). */
  tips: string[]
  /** Which tip to show; the parent rotates this over time. */
  index: number
  className?: string
}

export function ThinkingTips({ tips, index, className }: ThinkingTipsProps) {
  const { reduce, durationScale } = useFlowMotion()

  if (tips.length === 0) return null
  const tip = tips[((index % tips.length) + tips.length) % tips.length]

  const body = (
    <span className="inline-flex items-start gap-1.5">
      <LightbulbIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
      <span>{tip}</span>
    </span>
  )

  return (
    <div
      className={cn("px-1 py-1.5 text-xs text-muted-foreground", className)}
      role="note"
      aria-live="polite"
    >
      {reduce ? (
        body
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={index}
            className="inline-block"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 * durationScale, ease: "easeOut" }}
          >
            {body}
          </motion.span>
        </AnimatePresence>
      )}
    </div>
  )
}
