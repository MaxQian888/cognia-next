"use client"

// React hook for the per-account balance card. Reads the latest stored
// snapshot live (Dexie) and exposes a manual `refresh()` that runs the query
// runner and persists the result.

import { useCallback, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { isTauri } from "@/lib/tauri"
import { getDb } from "@/lib/db/schema"

import { queryAccountBalance } from "./runner"
import { recordBalanceSnapshot } from "./store"

import type { ProviderId, SubscriptionBalanceRow } from "@/types/subscription"

export interface UseAccountBalanceResult {
  /** Latest persisted snapshot for the account, or `null` when none yet. */
  snapshot: SubscriptionBalanceRow | null
  /** True while a manual refresh is in flight. */
  refreshing: boolean
  /** `true` when no adapter matched the account on the last refresh. */
  unavailable: boolean
  /** Run the query runner + persist the result. No-op outside Tauri. */
  refresh: () => Promise<void>
}

/**
 * Live latest-snapshot + manual refresh for one subscription account.
 *
 * The snapshot is read reactively from the `subscriptionBalance` table so a
 * refresh (or a refresh from another mounted card) updates every consumer.
 * `refresh()` calls `queryAccountBalance`; a `null` result means no adapter
 * matched (`unavailable`), a snapshot with `error` means the query failed.
 */
export function useAccountBalance(
  provider: ProviderId,
  accountId: string
): UseAccountBalanceResult {
  const [refreshing, setRefreshing] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  const snapshot =
    useLiveQuery(async () => {
      const rows = await getDb().subscriptionBalance.where("accountId").equals(accountId).toArray()
      if (rows.length === 0) return null
      return rows.reduce((newest, r) => (r.fetchedAt > newest.fetchedAt ? r : newest))
    }, [accountId]) ?? null

  const refresh = useCallback(async () => {
    if (!isTauri()) return
    setRefreshing(true)
    try {
      const result = await queryAccountBalance(provider, accountId)
      if (result === null) {
        setUnavailable(true)
        return
      }
      setUnavailable(false)
      await recordBalanceSnapshot(result)
    } finally {
      setRefreshing(false)
    }
  }, [provider, accountId])

  return { snapshot, refreshing, unavailable, refresh }
}
