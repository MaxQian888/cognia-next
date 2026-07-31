"use client"

/**
 * A number that springs to its new value when it changes — and only then.
 *
 * The distinction matters on the runtime panel: it re-renders once a second to
 * advance the elapsed-time text, so a counter animated by render (or by an
 * interval) would be in perpetual motion for as long as any run is live. The
 * `from === to` guard below is the thing that keeps it still; an identical
 * value on the next tick starts nothing.
 *
 * Driven by the imperative `animate()` rather than `useSpring`/`useMotionValue`
 * for two reasons. It writes straight to the text node, so a settling spring
 * costs no React renders. And it holds no React state of its own — the hook
 * forms depend on framer-motion's internal `useRef` identity, which is not
 * dependable when more than one React copy is resolvable (this repo's
 * node_modules carries three, and Jest binds motion to one of them).
 */

import { useEffect, useRef } from "react"
import { animate } from "motion/react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { MOBILE_SPRING } from "@/lib/ui/motion"

export interface RollingNumberProps {
  value: number
  className?: string
  "data-testid"?: string
}

const format = (n: number) => Math.round(n).toLocaleString()

export function RollingNumber({ value, className, ...rest }: RollingNumberProps) {
  const { reduce } = useFlowMotion()
  const ref = useRef<HTMLSpanElement>(null)
  /** What the node currently shows — the animation's start point. */
  const shown = useRef(value)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    if (reduce) {
      shown.current = value
      node.textContent = format(value)
      return
    }

    const from = shown.current
    if (from === value) {
      // Same value on a re-render (the 1s elapsed-time tick): paint it once if
      // the node is empty, then leave it alone.
      if (!node.textContent) node.textContent = format(value)
      return
    }

    const controls = animate(from, value, {
      ...MOBILE_SPRING,
      onUpdate: (v: number) => {
        shown.current = v
        node.textContent = format(v)
      },
      onComplete: () => {
        shown.current = value
        node.textContent = format(value)
      },
    })
    return () => controls.stop()
  }, [value, reduce])

  // Childless on purpose: the text node is owned by the effect above, so React
  // never fights it mid-animation. The initial paint happens on mount.
  return <span ref={ref} className={className} data-testid={rest["data-testid"]} />
}
