"use client"

// Height-collapsing wrapper for the rows stacked above the textarea (skill
// chips, folded-paste chips, the re-paste reminder, and the goal / loop /
// plan-mode status banners). It animates its OWN height to match its content
// so a child that mounts, unmounts, or self-hides (renders `null`) slides
// open / shut instead of making the whole composer jump vertically.
//
// Content-agnostic on purpose: callers don't pass an `open` flag — the wrapper
// measures the natural height of whatever it is given (0 when the child renders
// nothing), which is exactly what the self-hiding status pills need. Honors
// prefers-reduced-motion via the shared motion tokens (snaps, no animation).

import { motion } from "motion/react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"

export function Collapse({ children, className }: { children: ReactNode; className?: string }) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const transition = useReducedMotionTransition(mobileTransition("fast"))

  useEffect(() => {
    // The inner div is rendered unconditionally, so the ref is always attached
    // by the time this effect runs.
    const el = innerRef.current as HTMLDivElement
    const measure = () => setHeight(el.offsetHeight)
    measure()
    // Re-measure whenever the content's natural size changes (a child appears,
    // disappears, or reflows). ResizeObserver is absent in jsdom — the initial
    // measure above is enough there.
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <motion.div
      initial={false}
      animate={{ height }}
      transition={transition}
      style={{ overflow: "hidden" }}
      className={className}
    >
      <div ref={innerRef}>{children}</div>
    </motion.div>
  )
}
