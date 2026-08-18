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
  /**
   * Summed fresh input / output tokens for the bucket (optional — rows written
   * before the Cost tab read this table carry cost only). Lets the settings
   * Cost tab show volume for zero-cost (local / free-tier) models too.
   */
  inputTokens?: number
  outputTokens?: number
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
 * Result of a committed increment — the authority the in-memory budget mirror
 * reconciles against.
 */
export interface ProviderCostIncrementResult {
  /** Local day the increment landed in. */
  day: string
  providerId: string
  /** The provider's committed total for `day`, summed across all its models. */
  providerTotalUsd: number
}

/**
 * Add one successful turn's cost to today's rollup row (atomic upsert inside a
 * rw transaction so concurrent fire-and-forget writes never lose updates).
 * Invalid input (missing ids, non-positive/non-finite cost) is a silent no-op
 * and returns `null`.
 *
 * Returns the provider's committed day total so the caller can snap the
 * synchronous budget mirror to durable state.
 */
export async function incrementProviderCost(input: {
  providerId: string
  modelId: string
  costUsd: number
  /** Fresh input / output tokens of the turn — summed into the bucket. */
  inputTokens?: number
  outputTokens?: number
  now?: number
}): Promise<ProviderCostIncrementResult | null> {
  const { providerId, modelId, costUsd } = input
  if (!providerId || !modelId) return null
  if (!Number.isFinite(costUsd) || costUsd < 0) return null
  const inputTokens = Number.isFinite(input.inputTokens) ? Math.max(0, input.inputTokens ?? 0) : 0
  const outputTokens = Number.isFinite(input.outputTokens)
    ? Math.max(0, input.outputTokens ?? 0)
    : 0
  // A zero-cost turn only counts when it carried tokens (a local / free-tier
  // model); a bare `costUsd: 0` with nothing else stays the legacy no-op.
  if (costUsd === 0 && inputTokens === 0 && outputTokens === 0) return null

  const now = input.now ?? Date.now()
  const day = localDayString(now)
  const id = buildCostDailyId(day, providerId, modelId)
  const db = getDb()

  let providerTotalUsd = 0
  await db.transaction("rw", db.providerCostDaily, async () => {
    const existing = await db.providerCostDaily.get(id)
    if (existing) {
      await db.providerCostDaily.put({
        ...existing,
        totalCostUsd: existing.totalCostUsd + costUsd,
        requestCount: existing.requestCount + 1,
        inputTokens: (existing.inputTokens ?? 0) + inputTokens,
        outputTokens: (existing.outputTokens ?? 0) + outputTokens,
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
        inputTokens,
        outputTokens,
        updatedAt: now,
      })
    }
    // Sum the provider's rows for the day INSIDE the same transaction so the
    // returned figure is the committed truth, not a racy follow-up read. This is
    // what lets the in-memory budget mirror snap to durable state instead of
    // drifting: the mirror's optimistic increment and this write can otherwise
    // disagree permanently if the app dies between them.
    const dayRows = await db.providerCostDaily
      .where("[providerId+day]")
      .equals([providerId, day])
      .toArray()
    providerTotalUsd = dayRows.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0)
  })

  return { day, providerId, providerTotalUsd }
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
 * Most recent `updatedAt` per provider — the "recently used" signal for the
 * provider rail's sort. Walks the `updatedAt` index newest-first and stops
 * once every provider seen in the table has been visited, so the cost is
 * proportional to distinct providers rather than to the whole table.
 */
export async function getLastUsedByProvider(): Promise<Record<string, number>> {
  const table = getDb().providerCostDaily
  const providerIds = (await table.orderBy("providerId").uniqueKeys()) as string[]
  const remaining = new Set(providerIds)
  const lastUsed: Record<string, number> = {}
  if (remaining.size === 0) return lastUsed
  await table
    .orderBy("updatedAt")
    .reverse()
    .until(() => remaining.size === 0)
    .each((row) => {
      if (remaining.has(row.providerId)) {
        remaining.delete(row.providerId)
        lastUsed[row.providerId] = row.updatedAt
      }
    })
  return lastUsed
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
