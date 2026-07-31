"use client"

/**
 * useNowTicker — current wall-clock time (ms), refreshed once a second by the
 * shared `nowTickerStore`. Fleet rows and the permission countdown read it so
 * every live elapsed / countdown label is driven by ONE interval instead of one
 * timer per component.
 */

import { useSyncExternalStore } from "react"
import { nowTickerStore } from "@/lib/fleet/now-ticker-store"

export function useNowTicker(): number {
  return useSyncExternalStore(
    nowTickerStore.subscribe,
    nowTickerStore.getSnapshot,
    nowTickerStore.getServerSnapshot
  )
}
