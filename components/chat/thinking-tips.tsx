"use client"

/**
 * `<ThinkingTips>` — a single rotating "did you know" tip surfaced beneath the
 * thinking indicator once the wait has run long enough (see `useThinkingPhase`
 * / `ChatThinkingIndicator`). Purely presentational: the parent owns the tip
 * list and the rotating `index`; this component just crossfades whichever tip
 * the index points at.
 *
 * It is a footnote, not a second status: one muted line led by a quiet "Tip:"
 * label, no icon competing with the shimmering status word above it.
 *
 * Motion is gated by `useFlowMotion()` — reduced motion collapses the
 * crossfade to a plain swap (mirrors `MotionStatusSwap` in `motion-reveal`).
 *
 * ADR-0138 — two things here used to move the transcript every 5 seconds, for
 * the whole length of a tool-heavy turn:
 *
 *   - the crossfade translated on `y`, and `mode="wait"` meant the box was
 *     briefly empty between tips, so the row collapsed and sprang back;
 *   - tips are different lengths, so one wrapped to a second line and the next
 *     did not, changing the row's height under the reply.
 *
 * The box is therefore a fixed single line with the tip truncated to fit (the
 * full text stays in the `title`), and the two tips are stacked in one grid
 * cell so the outgoing and incoming copies overlap instead of taking turns.
 * Only `opacity` animates: the height is a constant, and the rotation cannot
 * reach the layout at all.
 */

import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"

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
  const t = useTranslations("chat.list")
  const { reduce, durationScale } = useFlowMotion()

  if (tips.length === 0) return null
  const tip = tips[((index % tips.length) + tips.length) % tips.length]

  const body = (
    // `h-4` is one line of `text-xs`; `truncate` keeps a long tip on it.
    <span className="block h-4 truncate" title={tip}>
      <span className="font-medium text-muted-foreground/80">{t("tipLabel")}</span> {tip}
    </span>
  )

  return (
    <div
      className={cn("grid min-w-0 px-1 py-1 text-xs text-muted-foreground", className)}
      role="note"
      aria-live="polite"
    >
      {reduce ? (
        body
      ) : (
        // No `mode="wait"`: the outgoing and incoming tips share one grid cell
        // and cross-fade over each other. Waiting would leave the cell empty
        // for a beat, and an empty cell is a height change.
        <AnimatePresence initial={false}>
          <motion.span
            key={index}
            className="col-start-1 row-start-1 min-w-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 * durationScale, ease: "easeOut" }}
          >
            {body}
          </motion.span>
        </AnimatePresence>
      )}
    </div>
  )
}
