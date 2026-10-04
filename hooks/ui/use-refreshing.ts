"use client"

/**
 * Run a refresh and say that it is running.
 *
 * A Refresh button wired straight to `void refresh()` fires and forgets, so a
 * click on a slow read looks like a click on nothing, and a second click
 * starts a second read behind the first. This holds a `refreshing` flag for
 * the duration, which the caller uses to disable the control and label it,
 * and ignores clicks while one is already in flight.
 *
 * The flag is cleared even when the refresh throws: a failed read must not
 * leave the button disabled for the rest of the session. The error itself is
 * the caller's to report, so it is re-thrown.
 */

import { useCallback, useRef, useState } from "react"

export interface UseRefreshingResult {
  refreshing: boolean
  run: () => Promise<void>
}

export function useRefreshing(refresh: () => Promise<void>): UseRefreshingResult {
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef(false)
  const run = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      inFlight.current = false
      setRefreshing(false)
    }
  }, [refresh])
  return { refreshing, run }
}
