"use client"

import { useEffect, useRef, useState } from "react"
import { useReducedMotion } from "motion/react"

/** Module scope so the default is a stable identity across renders. */
const defaultNow = () => performance.now()

interface UseCountUpOptions {
  /** The real value. Also the value rendered before the count starts. */
  to: number
  durationMs?: number
  /** The count runs once, when this first becomes true. */
  start: boolean
  /** Injected clock. Defaults to `performance.now`. */
  now?: () => number
}

/** Ease-out cubic. Fast at first, so the number reads as settling, not crawling. */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3
}

/**
 * **Tally** — count a number up to its real value once (ADR-0092 §6).
 *
 * Three design constraints, all load-bearing:
 *
 * 1. **It returns `to` until the count actually starts, not 0.** This site is a
 *    static export: the HTML must carry the real figure for a reader with no
 *    JavaScript and for anything reading the page mechanically. Starting at
 *    zero would ship `0 stars` into the markup and correct it only on
 *    hydration.
 *
 * 2. **It is plain React and `requestAnimationFrame`, not a motion value.** The
 *    repo maps `motion/react` to a shared mock in every suite; that mock's
 *    motion values expose an `on()` that never fires, and it does not export
 *    `animate` at all. A ticker built on `useSpring` would render its initial
 *    value forever under test while looking correct in a browser — the worst
 *    failure shape available.
 *
 * 3. **The displayed value is derived, never assigned from inside the effect.**
 *    The effect only advances `progress`; the render maps progress onto the
 *    number. Setting state synchronously in an effect body is a cascading
 *    render, and the repo's React-compiler lint rejects it.
 *
 * Under `prefers-reduced-motion` no frame is ever scheduled and the value is
 * simply the final one.
 */
export function useCountUp({
  to,
  durationMs = 900,
  start,
  now = defaultNow,
}: UseCountUpOptions): number {
  const reduced = useReducedMotion()
  // Counting to zero or below has nothing to show, and animating it would just
  // flash an empty stat.
  const animating = start && !reduced && to > 0
  const [progress, setProgress] = useState(0)
  const ranRef = useRef(false)

  useEffect(() => {
    if (!animating || ranRef.current) return
    ranRef.current = true

    const begunAt = now()
    let frame = 0

    const tick = () => {
      const elapsed = now() - begunAt
      const next = Math.min(1, elapsed / durationMs)
      setProgress(next)
      if (next < 1) frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [animating, durationMs, now])

  return animating ? Math.round(easeOut(progress) * to) : to
}
