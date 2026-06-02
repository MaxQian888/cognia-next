// Persistence for balance snapshots. Mirrors the cap pattern in
// `lib/subscription/anthropic/usage-collector.ts`: one Dexie write per
// recorded snapshot, capped newest-first so the table can't grow unbounded.

import { getDb } from "@/lib/db/schema"

import type { BalanceSnapshot, SubscriptionBalanceRow } from "@/types/subscription"

const CAP = 500

/**
 * Append a balance snapshot to the `subscriptionBalance` table and prune the
 * oldest rows back to `CAP`. Returns the persisted row (with `localId`).
 */
export async function recordBalanceSnapshot(
  snapshot: BalanceSnapshot
): Promise<SubscriptionBalanceRow> {
  const db = getDb()
  const row: SubscriptionBalanceRow = { ...snapshot }
  const localId = (await db.subscriptionBalance.add(row)) as number
  row.localId = localId

  const total = await db.subscriptionBalance.count()
  if (total > CAP) {
    const overflow = total - CAP
    const toDelete = await db.subscriptionBalance.orderBy("fetchedAt").limit(overflow).primaryKeys()
    if (toDelete.length > 0) {
      await db.subscriptionBalance.bulkDelete(toDelete)
    }
  }

  return row
}

/**
 * Latest stored snapshot for one account (by `fetchedAt`), or `null` when the
 * account has never been queried. Uses the `[providerKey+accountId]` index is
 * not possible here because providerKey isn't known by the caller, so we filter
 * on `accountId` then pick the newest.
 */
export async function latestBalanceSnapshot(
  accountId: string
): Promise<SubscriptionBalanceRow | null> {
  const db = getDb()
  const rows = await db.subscriptionBalance.where("accountId").equals(accountId).toArray()
  if (rows.length === 0) return null
  return rows.reduce((newest, r) => (r.fetchedAt > newest.fetchedAt ? r : newest))
}
