"use client"

// React hooks for the unified limits/usage surface. `useProviderLimits` reads
// the latest stored snapshot live (Dexie) and exposes a manual `refresh()` that
// runs the query runner and persists the result — the desktop Usage tab's
// per-provider card. `useAllConfiguredLimits` aggregates across every account
// for a multi-provider overview. Both degrade gracefully outside Tauri.

import { useCallback, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { isTauri } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"
import { useSettingsStore } from "@/stores/settings"

import { queryAccountLimitsCoalesced } from "./coalesce"
import { queryAllConfiguredLimits } from "./aggregate"
import { recordLimitsSnapshot } from "./store"

import type { ProviderId, ProviderLimits, ProviderLimitsRow } from "@/types/subscription"

export interface UseProviderLimitsResult {
  /** Latest persisted snapshot for the account, or `null` when none yet. */
  snapshot: ProviderLimitsRow | null
  /** True while a manual refresh is in flight. */
  refreshing: boolean
  /** `true` when no source matched the account on the last refresh. */
  unavailable: boolean
  /**
   * Run the query runner + persist the result. No-op outside Tauri. Automatic
   * callers omit `force` so they share the coalescer's throttle; an explicit
   * user "Refresh" passes `{ force: true }` to bypass it.
   */
  refresh: (options?: { force?: boolean }) => Promise<void>
}

/**
 * Live latest-snapshot + manual refresh for one subscription account. The
 * snapshot is read reactively from `providerLimits` so a refresh (or one from
 * another mounted card) updates every consumer. A `null` runner result means no
 * source applied (`unavailable`); a snapshot with `error` means the query failed.
 */
export function useProviderLimits(
  provider: ProviderId,
  accountId: string
): UseProviderLimitsResult {
  const [refreshing, setRefreshing] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  const snapshot =
    useLiveQuery(async () => {
      const rows = await getDb()
        .providerLimits.where("[provider+accountId]")
        .equals([provider, accountId])
        .toArray()
      if (rows.length === 0) return null
      return rows.reduce((newest, r) => (r.fetchedAt > newest.fetchedAt ? r : newest))
    }, [provider, accountId]) ?? null

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!isTauri()) return
      setRefreshing(true)
      try {
        const result = await queryAccountLimitsCoalesced(provider, accountId, {
          force: options?.force,
        })
        if (result === null) {
          setUnavailable(true)
          return
        }
        setUnavailable(false)
        await recordLimitsSnapshot(result)
      } finally {
        setRefreshing(false)
      }
    },
    [provider, accountId]
  )

  return { snapshot, refreshing, unavailable, refresh }
}

export interface UseAllConfiguredLimitsResult {
  /** Latest aggregated snapshots, active account first. */
  snapshots: ProviderLimits[]
  refreshing: boolean
  refresh: () => Promise<void>
}

/**
 * Aggregate the unified limits across every configured account. `refresh()`
 * runs `queryAllConfiguredLimits` (pinning `activeProvider` first), persists
 * each snapshot, and exposes the in-memory result. No-op outside Tauri.
 */
export function useAllConfiguredLimits(activeProvider?: ProviderId): UseAllConfiguredLimitsResult {
  const [snapshots, setSnapshots] = useState<ProviderLimits[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    if (!isTauri()) return
    setRefreshing(true)
    try {
      const all = await queryAllConfiguredLimits({
        activeProvider,
        // Read the custom-source list live so a freshly-added source is included.
        listCustomSources: () => useSettingsStore.getState().settings?.customLimitsSources ?? [],
        // Funnel every per-account query through the shared coalescer so the
        // status bar + tray + settings tabs don't stampede the rate-limited
        // usage endpoints (they all fire refresh on mount and on every
        // subscription-changed event).
        runAccount: (provider, accountId) => queryAccountLimitsCoalesced(provider, accountId),
      })
      setSnapshots(all)
      for (const snap of all) {
        await recordLimitsSnapshot(snap)
      }
    } finally {
      setRefreshing(false)
    }
  }, [activeProvider])

  return { snapshots, refreshing, refresh }
}
