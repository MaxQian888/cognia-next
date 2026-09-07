"use client"

// React hook for the per-account balance card. Reads the latest stored
// snapshot live (Dexie) and exposes a manual `refresh()` that runs the query
// runner and persists the result.

import { useCallback, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { isTauri } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"

import { queryAccountBalanceCoalesced } from "./coalesce"
import { recordBalanceSnapshot } from "./store"

import type { ProviderId, SubscriptionBalanceRow } from "@/types/subscription"

export interface UseAccountBalanceResult {
  /** Latest persisted snapshot for the account, or `null` when none yet. */
  snapshot: SubscriptionBalanceRow | null
  /** True while a manual refresh is in flight. */
  refreshing: boolean
  /** `true` when no adapter matched the account on the last refresh. */
  unavailable: boolean
  /**
   * Run the query runner + persist the result. No-op outside Tauri. Automatic
   * callers omit `force` so they share the coalescer's throttle; an explicit
   * user "Refresh" passes `{ force: true }` to bypass it. Neither can bypass a
   * provider-imposed block.
   */
  refresh: (options?: { force?: boolean }) => Promise<void>
}

/**
 * Live latest-snapshot + manual refresh for one subscription account.
 *
 * The snapshot is read reactively from the `subscriptionBalance` table so a
 * refresh (or a refresh from another mounted card) updates every consumer.
 * `refresh()` calls the coalesced runner; a `null` result means no adapter
 * matched (`unavailable`), a snapshot with `error` means the query failed.
 */
export function useAccountBalance(
  provider: ProviderId,
  accountId: string,
  queryEnabled: boolean
): UseAccountBalanceResult {
  const [refreshing, setRefreshing] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  const snapshot =
    useLiveQuery(async () => {
      const rows = await getDb().subscriptionBalance.where("accountId").equals(accountId).toArray()
      if (rows.length === 0) return null
      return rows.reduce((newest, r) => (r.fetchedAt > newest.fetchedAt ? r : newest))
    }, [accountId]) ?? null

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!queryEnabled || !isTauri()) return
      setRefreshing(true)
      try {
        const result = await queryAccountBalanceCoalesced(provider, accountId, {
          force: options?.force,
        })
        if (result === null) {
          setUnavailable(true)
          return
        }
        setUnavailable(false)
        await recordBalanceSnapshot(result)
      } finally {
        setRefreshing(false)
      }
    },
    [provider, accountId, queryEnabled]
  )

  return { snapshot, refreshing, unavailable, refresh }
}
