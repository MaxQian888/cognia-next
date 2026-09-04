/**
 * Subscribe a component to the shared {@link animationClock}.
 *
 * Returns the current frame while `active`, and a frozen 0 while it is not, so
 * an idle surface neither re-renders nor keeps a timer alive. Every component
 * on the same cadence receives the same number, which is what keeps a column of
 * spinners in step.
 */
import { useEffect, useState } from "react"

import { animationClock } from "./animation-clock"

export function useAnimationTick(intervalMs: number, active = true): number {
  // Seeded from the clock so a component mounting mid-animation joins the frame
  // its neighbours are already on instead of restarting the cycle. Read in the
  // initializer rather than an effect, which would be a cascading render.
  const [tick, setTick] = useState(() => animationClock.tick(intervalMs))

  useEffect(() => {
    if (!active) return
    return animationClock.subscribe(intervalMs, setTick)
  }, [intervalMs, active])

  return active ? tick : 0
}
