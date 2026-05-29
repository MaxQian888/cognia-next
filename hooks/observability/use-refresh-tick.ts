"use client"

/**
 * Drives auto-refresh for the observability dashboard. Returns a counter that
 * increments every `intervalMs`. `intervalMs <= 0` disables the timer (the
 * counter stays at 0) — relying instead on Dexie `useLiveQuery` reactivity for
 * updates. Consumers put the returned tick in a `useMemo`/`useLiveQuery` dep
 * list to recompute relative time windows as the wall clock advances.
 */

import { useEffect, useState } from "react"

export function useRefreshTick(intervalMs: number): number {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return
    const id = setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return tick
}
