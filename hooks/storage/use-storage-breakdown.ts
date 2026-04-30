"use client"

// Per-category storage stats + health for the Overview tab. Distinct from
// `hooks/data/use-storage-stats.ts` which returns live-queried row counts;
// this one walks every Dexie table once to compute the size breakdown that
// the visual bar / health-status cards consume.

import { useCallback, useEffect, useRef, useState } from "react"
import { StorageManager } from "@/lib/storage"
import type { StorageHealth, StorageStats } from "@/lib/storage"

export interface UseStorageBreakdownOptions {
  /** Auto-refresh cadence in ms. `0` (default) disables polling. */
  refreshInterval?: number
}

export interface UseStorageBreakdownReturn {
  stats: StorageStats | null
  health: StorageHealth | null
  isLoading: boolean
  error: Error | null
  refresh: () => Promise<void>
  formatBytes: (bytes: number) => string
}

export function useStorageBreakdown(
  options: UseStorageBreakdownOptions = {}
): UseStorageBreakdownReturn {
  const { refreshInterval = 0 } = options
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [health, setHealth] = useState<StorageHealth | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Manual / interval refresh — does NOT flip `isLoading`. We only carry
  // `isLoading=true` while the *initial* mount-time fetch is in flight; on
  // subsequent refreshes the previous data stays visible underneath.
  const refresh = useCallback(async () => {
    try {
      const [nextStats, nextHealth] = await Promise.all([
        StorageManager.getStats(),
        StorageManager.getHealth(),
      ])
      setStats(nextStats)
      setHealth(nextHealth)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    }
  }, [])

  // Initial fetch. Structured as Promise.all().then() (not async/await)
  // because the React Compiler's `set-state-in-effect` lint rule flags
  // synchronous `setState` calls inside an effect body — the same pattern
  // used by `hooks/data/use-storage-stats.ts` for its quota fetch.
  useEffect(() => {
    let cancelled = false
    Promise.all([StorageManager.getStats(), StorageManager.getHealth()])
      .then(([nextStats, nextHealth]) => {
        if (cancelled) return
        setStats(nextStats)
        setHealth(nextHealth)
        setIsLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (refreshInterval <= 0) return
    intervalRef.current = setInterval(() => {
      void refresh()
    }, refreshInterval)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [refreshInterval, refresh])

  return {
    stats,
    health,
    isLoading,
    error,
    refresh,
    formatBytes: StorageManager.formatBytes,
  }
}
