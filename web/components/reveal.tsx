"use client"

import { motion, useReducedMotion } from "motion/react"
import type { ReactNode } from "react"
import { EASE_ENTRANCE } from "@web/lib/motion"

interface RevealProps {
  children: ReactNode
  className?: string
  /** `scale` is the product-image treatment; `fade` is for text blocks. */
  variant?: "scale" | "fade"
  /**
   * `view` waits for the element to enter the viewport — correct for anything
   * below the fold. `mount` animates immediately and is required for content
   * that is *already* on the first screen: a tall element whose top sits near
   * the fold can never satisfy the in-view threshold at load, so a `view`
   * trigger would leave the largest visual on the page at `opacity: 0` until the
   * reader happened to scroll. A reader who does not scroll is exactly the
   * reader the first screen is for.
   */
  trigger?: "view" | "mount"
  delay?: number
}

/**
 * The site's two entrance motions (spec §6).
 *
 * `scale` is the product-image treatment: 0.96 → 1 with a fade, no parallax, so
 * the frame stays sharp-edged. `fade` is the text treatment. Both animate only
 * `transform` and `opacity`, which is the spec's performance rule.
 *
 * With `prefers-reduced-motion` the content renders in its final state
 * immediately — not a shortened animation, no animation. Order, layout and
 * every call to action are identical either way.
 */
export function Reveal({
  children,
  className,
  variant = "fade",
  trigger = "view",
  delay = 0,
}: RevealProps) {
  const reduced = useReducedMotion()

  if (reduced) {
    return <div className={className}>{children}</div>
  }

  const initial = variant === "scale" ? { opacity: 0, scale: 0.96 } : { opacity: 0, y: 12 }
  const target = variant === "scale" ? { opacity: 1, scale: 1 } : { opacity: 1, y: 0 }
  const transition = { duration: 0.5, delay, ease: EASE_ENTRANCE }

  if (trigger === "mount") {
    return (
      <motion.div
        data-reveal=""
        className={className}
        initial={initial}
        animate={target}
        transition={transition}
      >
        {children}
      </motion.div>
    )
  }

  return (
    <motion.div
      data-reveal=""
      className={className}
      initial={initial}
      whileInView={target}
      viewport={{ once: true, amount: 0.2 }}
      transition={transition}
    >
      {children}
    </motion.div>
  )
}
