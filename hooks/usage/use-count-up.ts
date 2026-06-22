"use client"

/**
 * `useCountUp` — animate a number from its previous value to a new target with
 * an ease-out tween, used by the usage stat tiles so headline figures count up
 * instead of snapping. GPU-free (it only drives a React number), so it stays
 * cheap even with several tiles on screen.
 *
 * Honours reduced motion: when `disabled` is set (the caller wires this to
 * `useFlowMotion().reduce` / the OS `prefers-reduced-motion` hint) the hook
 * returns the target immediately with no animation frames. A zero/negative
 * duration or a non-finite target also short-circuits to the raw value — those
 * paths return `target` straight from render (no `setState`), so the tween state
 * is only ever touched asynchronously inside `requestAnimationFrame`.
 */

import { useEffect, useRef, useState } from "react"

export interface CountUpOptions {
  /** Tween duration in ms (instant when `disabled`). */
  durationMs?: number
  /** Skip the animation and jump straight to the target. */
  disabled?: boolean
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

export function useCountUp(target: number, options: CountUpOptions = {}): number {
  const { durationMs = 600, disabled = false } = options
  const shouldAnimate = !disabled && durationMs > 0 && Number.isFinite(target)
  const [animated, setAnimated] = useState(target)
  const fromRef = useRef(target)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!shouldAnimate) {
      fromRef.current = target
      return
    }

    const from = fromRef.current
    if (from === target) return

    let start: number | null = null
    const tick = (ts: number) => {
      if (start === null) start = ts
      const t = Math.min(1, (ts - start) / durationMs)
      const next = from + (target - from) * easeOutCubic(t)
      setAnimated(next)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = target
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      // Adopt the latest target as the next animation's origin so an
      // interrupted tween resumes from where it left off conceptually.
      fromRef.current = target
    }
  }, [target, durationMs, shouldAnimate])

  // Non-animating paths render the raw target directly — no synchronous state
  // write in the effect, which keeps the React compiler/linter happy.
  return shouldAnimate ? animated : target
}
