/**
 * Persistent provider cost tracking (Dexie table `providerCostDaily`, schema v75).
 *
 * One row per `provider + model + local day`, upsert-incremented from
 * `recordProviderOutcome` (fire-and-forget — never blocks the send path).
 * Day boundary is the user's LOCAL day so "daily budget" matches intuition.
 * The routing engine never reads this table directly; it reads the in-memory
 * mirror (`stores/settings/provider-cost-mirror-store.ts`) hydrated at boot.
 */

import { getDb } from "./schema"

export interface ProviderCostDailyRow {
  /** `${day}|${providerId}|${modelId}`. */
  id: string
  /** Local-day bucket, "YYYY-MM-DD". Indexed for range/prune queries. */
  day: string
  providerId: string
  modelId: string
  /** Summed estimated cost (USD) for the bucket. */
  totalCostUsd: number
  /** Number of successful turns that contributed cost. */
  requestCount: number
  /** Epoch ms of the last increment. */
  updatedAt: number
}

/** Format an epoch-ms timestamp as the user's LOCAL "YYYY-MM-DD" day string. */
export function localDayString(now: number = Date.now()): string {
  const d = new Date(now)
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${month}-${day}`
}

/** Build the canonical row id from its parts. */
export function buildCostDailyId(day: string, providerId: string, modelId: string): string {
  return `${day}|${providerId}|${modelId}`
}

/**
 * Add one successful turn's cost to today's rollup row (atomic upsert inside a
 * rw transaction so concurrent fire-and-forget writes never lose updates).
 * Invalid input (missing ids, non-positive/non-finite cost) is a silent no-op.
 */
export async function incrementProviderCost(input: {
  providerId: string
  modelId: string
  costUsd: number
  now?: number
}): Promise<void> {
  const { providerId, modelId, costUsd } = input
  if (!providerId || !modelId) return
  if (!Number.isFinite(costUsd) || costUsd <= 0) return

  const now = input.now ?? Date.now()
  const day = localDayString(now)
  const id = buildCostDailyId(day, providerId, modelId)
  const db = getDb()

  await db.transaction("rw", db.providerCostDaily, async () => {
    const existing = await db.providerCostDaily.get(id)
    if (existing) {
      await db.providerCostDaily.put({
        ...existing,
        totalCostUsd: existing.totalCostUsd + costUsd,
        requestCount: existing.requestCount + 1,
        updatedAt: now,
      })
    } else {
      await db.providerCostDaily.put({
        id,
        day,
        providerId,
        modelId,
        totalCostUsd: costUsd,
        requestCount: 1,
        updatedAt: now,
      })
    }
  })
}

/**
 * Today's spend per provider (summed across models) — the boot-hydration read
 * for the in-memory budget mirror.
 */
export async function getTodaysCostByProvider(
  now: number = Date.now()
): Promise<Record<string, number>> {
  const day = localDayString(now)
  const rows = await getDb().providerCostDaily.where("day").equals(day).toArray()
  const totals: Record<string, number> = {}
  for (const row of rows) {
    totals[row.providerId] = (totals[row.providerId] ?? 0) + row.totalCostUsd
  }
  return totals
}

/** Rows for an inclusive day range (ISO day strings compare lexicographically). */
export async function getCostRange(
  fromDay: string,
  toDay: string
): Promise<ProviderCostDailyRow[]> {
  return getDb().providerCostDaily.where("day").between(fromDay, toDay, true, true).toArray()
}

/**
 * Drop rollup rows older than {@param days} days. Returns the number removed.
 * `days <= 0` is treated as "never prune".
 */
export async function pruneProviderCostOlderThan(
  days: number,
  now: number = Date.now()
): Promise<number> {
  if (!Number.isFinite(days) || days <= 0) return 0
  const cutoffDay = localDayString(now - days * 86_400_000)
  const db = getDb()
  const stale = await db.providerCostDaily.where("day").below(cutoffDay).primaryKeys()
  if (stale.length === 0) return 0
  await db.providerCostDaily.bulkDelete(stale)
  return stale.length
}
