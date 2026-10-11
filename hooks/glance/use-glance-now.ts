"use client"

/**
 * The clock every glance build judges relative states by (ADR-0225 §7):
 * "stale", "in 14 h", "updated 3 min ago". It ticks while a consumer is on
 * screen and freezes otherwise, so a closed surface re-renders nothing.
 */

import { useEffect, useState } from "react"

/** How often relative states (stale, "in 14 h") are re-evaluated while visible. */
export const GLANCE_TICK_MS = 30_000

/** A ticking clock while `active`, frozen otherwise. */
export function useGlanceNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    // Re-read immediately on becoming visible, so a panel opened after an hour
    // closed does not judge freshness against the time it was last open.
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, GLANCE_TICK_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active])
  return now
}
