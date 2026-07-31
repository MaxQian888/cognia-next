// Persistence for unified provider-limits snapshots. Mirrors the cap pattern in
// `lib/subscription/balance/store.ts`: one Dexie write per recorded snapshot,
// capped newest-first so the `providerLimits` table can't grow unbounded.

import { getDb } from "@/lib/db/schema"

import type { ProviderLimits, ProviderLimitsRow } from "@/types/subscription"

const CAP = 500

/**
 * Append a limits snapshot to the `providerLimits` table and prune the oldest
 * rows back to `CAP`. Returns the persisted row (with `localId`).
 */
export async function recordLimitsSnapshot(snapshot: ProviderLimits): Promise<ProviderLimitsRow> {
  const db = getDb()
  const row: ProviderLimitsRow = { ...snapshot }
  const localId = (await db.providerLimits.add(row)) as number
  row.localId = localId

  const total = await db.providerLimits.count()
  if (total > CAP) {
    const overflow = total - CAP
    const toDelete = await db.providerLimits.orderBy("fetchedAt").limit(overflow).primaryKeys()
    if (toDelete.length > 0) {
      await db.providerLimits.bulkDelete(toDelete)
    }
  }

  return row
}

/**
 * Latest stored snapshot for one provider account (by `fetchedAt`), or `null`
 * when never queried. Filters on the `[provider+accountId]` compound key then
 * picks the newest.
 */
export async function latestLimitsSnapshot(
  provider: string,
  accountId: string
): Promise<ProviderLimitsRow | null> {
  const db = getDb()
  const rows = await db.providerLimits
    .where("[provider+accountId]")
    .equals([provider, accountId])
    .toArray()
  if (rows.length === 0) return null
  return rows.reduce((newest, r) => (r.fetchedAt > newest.fetchedAt ? r : newest))
}
