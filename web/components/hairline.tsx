"use client"

import { motion, useReducedMotion } from "motion/react"
import { cn } from "@web/lib/utils"

/**
 * Slower and softer than the entrance curve: a rule being drawn is a measuring
 * gesture, not an arrival, and it should finish after the block it underlines
 * has settled.
 */
const EASE = [0.16, 1, 0.3, 1] as const
const DURATION_S = 0.7

export type HairlineTone = "hairline" | "hairline-strong" | "action" | "on-stage-hairline"

const TONE_CLASS: Record<HairlineTone, string> = {
  hairline: "bg-hairline",
  "hairline-strong": "bg-hairline-strong",
  // Cyan as a line, which is the one thing ADR-0092 §10 permits it to be — it
  // is 1.69:1 on paper and must never carry text.
  action: "bg-action",
  "on-stage-hairline": "bg-on-stage-hairline",
}

interface HairlineProps {
  /** `x` draws left-to-right; `y` draws top-to-bottom. */
  orientation?: "x" | "y"
  tone?: HairlineTone
  className?: string
  delay?: number
}

/**
 * **Draw** — a hairline that draws itself once, on entering the viewport
 * (ADR-0092 §6).
 *
 * The site's whole visual language is 1px rules used as measurement marks
 * rather than decoration (spec §2.4). Drawing one is therefore the most
 * on-voice motion available to it: nothing appears that was not already part
 * of the layout, and the gesture is the instrument's, not the interface's.
 *
 * Only `transform` animates, which is the spec's performance rule. It is
 * deliberately **not** built on `animation-timeline: view()`: in Chrome 147
 * `CSS.supports` reports that syntax as supported while the resulting
 * `ViewTimeline` sits at `currentTime: null` and never applies, and a
 * scroll-driven animation would in any case escape the `prefers-reduced-motion`
 * belt in `globals.css`, which only collapses time-driven ones.
 *
 * Decorative, so it is always `aria-hidden`: a rule is not content, and the
 * blocks it separates carry their own headings.
 */
export function Hairline({
  orientation = "x",
  tone = "hairline",
  className,
  delay = 0,
}: HairlineProps) {
  const reduced = useReducedMotion()
  const box = orientation === "x" ? "h-px w-full origin-left" : "h-full w-px origin-top"
  const classes = cn("block", box, TONE_CLASS[tone], className)

  if (reduced) {
    // The finished rule, drawn instantly. Same box, same colour, no transform —
    // so the layout is identical in both modes.
    return <span aria-hidden className={classes} />
  }

  const axis = orientation === "x" ? "scaleX" : "scaleY"

  return (
    <motion.span
      aria-hidden
      className={classes}
      initial={{ [axis]: 0 }}
      whileInView={{ [axis]: 1 }}
      viewport={{ once: true, amount: 0.6 }}
      transition={{ duration: DURATION_S, ease: EASE, delay }}
    />
  )
}
