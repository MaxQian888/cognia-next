"use client"

/**
 * Drives auto-refresh for the observability dashboard. Returns a counter that
 * increments every `intervalMs`, the wall-clock time of the last increment, and
 * a `refresh()` for an on-demand tick. `intervalMs <= 0` disables the timer (the
 * counter stays put) — relying instead on Dexie `useLiveQuery` reactivity for
 * updates. Consumers put `tick` in a `useMemo`/`useLiveQuery` dep list to
 * recompute relative time windows as the wall clock advances.
 *
 * `Date.now()` is read only inside effects/callbacks (never render), so this
 * stays render-pure per the repo's purity lint.
 */

import { useCallback, useEffect, useState } from "react"

export interface RefreshTick {
  /** Monotonic counter — bumps on each interval and each manual `refresh()`. */
  tick: number
  /** Epoch ms of the last tick (or mount); null before the mount effect runs. */
  lastUpdated: number | null
  /** Force an immediate tick without waiting for the interval. */
  refresh: () => void
}

export function useRefreshTick(intervalMs: number): RefreshTick {
  const [tick, setTick] = useState(0)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)

  // Stamp an initial "updated at" once mounted. Deferred to a macrotask so it's
  // not a synchronous setState in the effect body (avoids cascading-render lint;
  // Date.now stays out of render).
  useEffect(() => {
    const id = setTimeout(() => setLastUpdated(Date.now()), 0)
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return
    const id = setInterval(() => {
      setTick((t) => t + 1)
      setLastUpdated(Date.now())
    }, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  const refresh = useCallback(() => {
    setTick((t) => t + 1)
    setLastUpdated(Date.now())
  }, [])

  return { tick, lastUpdated, refresh }
}
