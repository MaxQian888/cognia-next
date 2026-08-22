/**
 * CRUD layer for the `connectorCleanupJobs` Dexie table (schema v178).
 *
 * Removing a cached attachment is two writes in two stores: the encrypted
 * envelope on disk (Rust) and the `connectorAttachments` row (Dexie). The disk
 * half can fail — a locked file, a permissions change, or a headless host with
 * no Rust side at all — and the old code ignored that, dropping the row and
 * orphaning ciphertext that nothing could ever find again.
 *
 * This ledger is the fix. A blob is only forgotten once Rust confirms it is
 * gone; every other outcome becomes a job here, retried with exponential
 * backoff and surfaced in connector health diagnostics.
 */

import type { ConnectorCleanupJobRow } from "./connector-types"
import { getDb } from "./schema"

/** First retry waits this long; each further attempt doubles it. */
const BASE_BACKOFF_MS = 30_000
/** Backoff ceiling — a stuck job still gets retried twice an hour. */
const MAX_BACKOFF_MS = 30 * 60 * 1000
/**
 * Attempts before a job stops being retried automatically. It is NOT deleted:
 * it stays visible in diagnostics so a permanently undeletable blob is a
 * reported problem rather than a silent one.
 */
export const MAX_CLEANUP_ATTEMPTS = 12

export interface EnqueueCleanupJobInput {
  cacheKey: string
  adapterId: string
  reason: ConnectorCleanupJobRow["reason"]
  error?: string
}

/**
 * Record that `cacheKey` still needs its blob deleted.
 *
 * Re-enqueuing an existing job keeps its attempt count and backoff — a blob
 * that has failed six times must not be reset to "try immediately" just
 * because another caller noticed it too.
 */
export async function enqueueCleanupJob(
  input: EnqueueCleanupJobInput,
  now: number = Date.now()
): Promise<ConnectorCleanupJobRow> {
  const db = getDb()
  const existing = await db.connectorCleanupJobs.get(input.cacheKey)
  if (existing) {
    const merged: ConnectorCleanupJobRow = {
      ...existing,
      // Keep the most specific reason we have rather than overwriting a
      // precise one ("adapter_removed") with a generic sweep ("orphaned").
      reason: existing.reason,
      lastError: input.error ?? existing.lastError,
    }
    await db.connectorCleanupJobs.put(merged)
    return merged
  }
  const row: ConnectorCleanupJobRow = {
    id: input.cacheKey,
    adapterId: input.adapterId,
    reason: input.reason,
    attempts: 0,
    nextAttemptAt: now,
    lastError: input.error,
    createdAt: now,
  }
  await db.connectorCleanupJobs.put(row)
  return row
}

/** Jobs whose backoff has elapsed and which have attempts left. */
export async function listDueCleanupJobs(
  now: number = Date.now(),
  limit = 100
): Promise<ConnectorCleanupJobRow[]> {
  const db = getDb()
  const due = await db.connectorCleanupJobs
    .where("nextAttemptAt")
    .belowOrEqual(now)
    .limit(limit)
    .toArray()
  return due.filter((job) => job.attempts < MAX_CLEANUP_ATTEMPTS)
}

/** Every job, including exhausted ones — the diagnostics view. */
export async function listCleanupJobs(): Promise<ConnectorCleanupJobRow[]> {
  return getDb().connectorCleanupJobs.orderBy("createdAt").toArray()
}

/** Jobs that have burned every attempt and now need a human. */
export async function listExhaustedCleanupJobs(): Promise<ConnectorCleanupJobRow[]> {
  const all = await listCleanupJobs()
  return all.filter((job) => job.attempts >= MAX_CLEANUP_ATTEMPTS)
}

/** The blob is gone — forget the job. */
export async function resolveCleanupJob(cacheKey: string): Promise<void> {
  await getDb().connectorCleanupJobs.delete(cacheKey)
}

/**
 * The delete failed again: bump the attempt count and push the next attempt
 * out exponentially, capped.
 */
export async function recordCleanupFailure(
  cacheKey: string,
  error: string,
  now: number = Date.now()
): Promise<ConnectorCleanupJobRow | undefined> {
  const db = getDb()
  const existing = await db.connectorCleanupJobs.get(cacheKey)
  if (!existing) return undefined
  const attempts = existing.attempts + 1
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS)
  const row: ConnectorCleanupJobRow = {
    ...existing,
    attempts,
    lastAttemptAt: now,
    nextAttemptAt: now + backoff,
    lastError: error,
  }
  await db.connectorCleanupJobs.put(row)
  return row
}

/** Drop every job for an adapter — used when its instance row is deleted. */
export async function clearCleanupJobsForAdapter(adapterId: string): Promise<number> {
  const db = getDb()
  const keys = await db.connectorCleanupJobs.where("adapterId").equals(adapterId).primaryKeys()
  if (keys.length === 0) return 0
  await db.connectorCleanupJobs.bulkDelete(keys as string[])
  return keys.length
}
