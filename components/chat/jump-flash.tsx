"use client"

/**
 * The "you landed here" mark painted over a message row right after a jump.
 *
 * Rendered as an overlay rather than as classes on the row itself, for two
 * reasons: the row's own class list is already carrying the search-hit ring and
 * the mobile long-press wrapper, and a keyed overlay restarts cleanly when you
 * jump to the same message twice (a class toggle would not re-run the
 * animation without a forced reflow).
 *
 * Only `opacity` and `transform` animate — the same GPU-friendly constraint the
 * rest of the chat motion primitives hold to, so flashing a row inside a
 * tool-dense reply costs no layout.
 */

import { motion } from "motion/react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { cn } from "@/lib/utils"

export interface JumpFlashProps {
  /** Changing this restarts the mark; see `useJumpFlash`'s nonce. */
  nonce: number
  /** Hold time in ms — the fade runs for exactly this long. */
  holdMs: number
  className?: string
}

export function JumpFlash({ nonce, holdMs, className }: JumpFlashProps) {
  const { reduce } = useFlowMotion()
  const seconds = holdMs / 1000

  return (
    <span
      aria-hidden
      data-testid="jump-flash"
      data-jump-flash-nonce={nonce}
      className={cn("pointer-events-none absolute inset-0 z-10", className)}
    >
      {reduce ? (
        // Reduced motion still needs the answer to "where did I land?", so the
        // mark is held flat for the same beat and then unmounted by the hook,
        // rather than animated away.
        <>
          <span className="absolute inset-0 rounded-md bg-primary/10" />
          <span className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-primary" />
        </>
      ) : (
        <>
          <motion.span
            key={`wash-${nonce}`}
            className="absolute inset-0 rounded-md bg-primary/10"
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: seconds, ease: "easeOut" }}
          />
          <motion.span
            key={`bar-${nonce}`}
            className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-primary"
            initial={{ opacity: 1, x: -6 }}
            animate={{ opacity: 0, x: 0 }}
            transition={{
              x: { duration: Math.min(0.28, seconds), ease: [0.2, 0.8, 0.2, 1] },
              opacity: { duration: seconds, ease: "easeOut" },
            }}
          />
        </>
      )}
    </span>
  )
}
