/**
 * Renderer-side surface over the encrypted connector attachment cache.
 *
 * Rust (`crates/cognia-connectors/src/attachments.rs`) is the authority for
 * everything that can be got wrong: the cache key, at-rest encryption, the
 * real byte count, TTL expiry, the access stamp that makes eviction a genuine
 * LRU, and deletion. This module keeps the `connectorAttachments` index that
 * the inbox UI reads, and reconciles it with what Rust actually holds.
 *
 * Three rules follow from that split, and each of them replaces a defect:
 *
 *   1. **Sizes and expiry come back from Rust.** They used to be caller hints
 *      defaulting to `sizeBytes: 0`, which made the 500 MB LRU cap
 *      unreachable — every entry summed to zero, so nothing was ever evicted.
 *   2. **Freshness is never decided here.** The old code compared `expiresAt`
 *      client-side and then called a Rust cache that had no TTL at all, so a
 *      "refresh" returned the same stale bytes it was trying to replace.
 *   3. **A Dexie row is dropped only after Rust confirms the blob is gone.**
 *      Deleting the row first is what orphaned ciphertext with no way to find
 *      it again; failures now go to `connectorCleanupJobs` for retry.
 */

import {
  connectorsAttachmentDelete,
  connectorsAttachmentEnforceBudget,
  connectorsAttachmentEvictAdapter,
  connectorsAttachmentFetch,
  connectorsAttachmentList,
} from "@/lib/connectors/tauri/commands"
import type { AttachmentCleanupReport, AttachmentRef } from "@/lib/connectors/tauri/commands"
import {
  enqueueCleanupJob,
  listDueCleanupJobs,
  recordCleanupFailure,
  resolveCleanupJob,
} from "@/lib/db/connector-cleanup-jobs"
import type { ConnectorAttachmentRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"

export interface FetchAttachmentInput {
  adapterId: string
  remoteRef: string
  sourceUrl: string
  /** Optional mime hint; persisted alongside the row when present. */
  mimeType?: string
  /** Optional request headers for authenticated media repositories. */
  headers?: Record<string, string>
  /**
   * Lifetime for a freshly written entry, ms. Defaults to Rust's 7 days; pass
   * `0` for "never expires, LRU only".
   */
  ttlMs?: number
}

export interface FetchAttachmentResult {
  ref: AttachmentRef
  /** True when Rust served the bytes from cache without a network fetch. */
  cached: boolean
}

/** 500 MB ceiling over the real decrypted sizes held in the envelopes. */
export const LRU_TOTAL_CAP_BYTES = 500 * 1024 * 1024

/**
 * Cache key for an attachment: hex SHA-256 of `"<adapterId>:<remoteRef>"`.
 * Must stay byte-identical to `compute_cache_key` in `attachments.rs` — it is
 * the only thing relating a Dexie row to a file on disk.
 */
export async function computeCacheKey(adapterId: string, remoteRef: string): Promise<string> {
  const data = new TextEncoder().encode(`${adapterId}:${remoteRef}`)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Fetch (or recover from cache) an attachment for the given adapter.
 *
 * Always delegates to Rust: it holds the only correct answer to "is this entry
 * still live?", and short-circuiting here on a locally cached row is what let
 * expired entries be served forever.
 */
export async function fetchAttachment(input: FetchAttachmentInput): Promise<FetchAttachmentResult> {
  const db = getDb()
  const existing = await db.connectorAttachments
    .where("[adapterId+remoteRef]")
    .equals([input.adapterId, input.remoteRef])
    .first()

  const ref = await connectorsAttachmentFetch(
    input.adapterId,
    input.remoteRef,
    input.sourceUrl,
    input.headers,
    input.ttlMs
  )

  const row: ConnectorAttachmentRow = {
    id: `${input.adapterId}:${input.remoteRef}`,
    adapterId: input.adapterId,
    remoteRef: input.remoteRef,
    cacheKey: ref.cacheKey,
    mimeType: input.mimeType ?? existing?.mimeType ?? "application/octet-stream",
    sizeBytes: ref.sizeBytes,
    fetchedAt: ref.createdAt,
    lastAccessedAt: ref.lastAccessedAt,
    expiresAt: ref.expiresAt,
  }
  await db.connectorAttachments.put(row)

  // Best-effort budget sweep — if it fails the row still landed, and the next
  // fetch (or the housekeeping sweep) retries it.
  await enforceAttachmentBudget().catch(() => undefined)

  return { ref, cached: ref.cached }
}

/**
 * Enforce the cache ceiling. Rust evicts by real size and real access time and
 * tells us what it removed; the matching Dexie rows are dropped to match.
 */
export async function enforceAttachmentBudget(
  capBytes: number = LRU_TOTAL_CAP_BYTES
): Promise<AttachmentCleanupReport> {
  const report = await connectorsAttachmentEnforceBudget(capBytes)
  await dropRowsForDeletedKeys(report.deleted)
  await ledgerFailures(report)
  return report
}

/**
 * Remove every cached attachment belonging to an adapter — called when its
 * instance is deleted, so its media does not outlive it.
 *
 * Rows are dropped for confirmed deletes only. Entries Rust could not match
 * (blobs migrated from the pre-envelope format carry no adapter provenance)
 * are deleted by cache key in a second pass, and anything still unconfirmed
 * goes to the cleanup ledger.
 */
export async function pruneAttachmentsForAdapter(adapterId: string): Promise<number> {
  const db = getDb()
  const rows = await db.connectorAttachments.where("adapterId").equals(adapterId).toArray()

  const byAdapter = await connectorsAttachmentEvictAdapter(adapterId)
  const confirmed = new Set(byAdapter.deleted)
  await ledgerFailures(byAdapter, adapterId, "adapter_removed")

  // Second pass by explicit key: covers rows whose blob predates the envelope
  // format (zeroed adapter hash) and rows Rust never knew about.
  const remaining = await Promise.all(
    rows
      .filter((row) => !confirmed.has(row.cacheKey))
      .map(async (row) => ({
        row,
        cacheKey: row.cacheKey || (await computeCacheKey(row.adapterId, row.remoteRef)),
      }))
  )
  if (remaining.length > 0) {
    const byKey = await connectorsAttachmentDelete(remaining.map((r) => r.cacheKey))
    byKey.deleted.forEach((key) => confirmed.add(key))
    await ledgerFailures(byKey, adapterId, "adapter_removed")
  }

  const deletable = rows.filter(
    (row) =>
      confirmed.has(row.cacheKey) ||
      remaining.some((r) => r.row.id === row.id && confirmed.has(r.cacheKey))
  )
  if (deletable.length > 0) {
    await db.connectorAttachments.bulkDelete(deletable.map((row) => row.id))
  }
  return deletable.length
}

/**
 * Delete blobs Rust still holds that no `connectorAttachments` row claims.
 *
 * Orphans are the residue of every path that dropped a row without deleting
 * the file — including every such delete performed by older builds — so the
 * sweep is what actually reclaims that space.
 */
export async function reconcileOrphanedAttachments(): Promise<AttachmentCleanupReport> {
  const db = getDb()
  const [entries, rows] = await Promise.all([
    connectorsAttachmentList(),
    db.connectorAttachments.toArray(),
  ])

  const known = new Set<string>()
  for (const row of rows) {
    known.add(row.cacheKey || (await computeCacheKey(row.adapterId, row.remoteRef)))
  }
  const orphans = entries.filter((entry) => !known.has(entry.cacheKey)).map((e) => e.cacheKey)
  if (orphans.length === 0) {
    return { deleted: [], freedBytes: 0, failed: [] }
  }
  const report = await connectorsAttachmentDelete(orphans)
  await ledgerFailures(report, undefined, "orphaned")
  return report
}

/**
 * Retry the cleanup ledger. Jobs whose blob is now gone are resolved; the rest
 * have their backoff extended and stay visible in diagnostics.
 */
export async function runCleanupLedger(now: number = Date.now()): Promise<{
  resolved: number
  stillFailing: number
}> {
  const due = await listDueCleanupJobs(now)
  if (due.length === 0) return { resolved: 0, stillFailing: 0 }

  const report = await connectorsAttachmentDelete(due.map((job) => job.id))
  const deleted = new Set(report.deleted)
  const failureByKey = new Map(report.failed.map((f) => [f.cacheKey, f.error]))

  let resolved = 0
  let stillFailing = 0
  for (const job of due) {
    if (deleted.has(job.id)) {
      await resolveCleanupJob(job.id)
      resolved += 1
      continue
    }
    await recordCleanupFailure(job.id, failureByKey.get(job.id) ?? "delete not confirmed", now)
    stillFailing += 1
  }
  await dropRowsForDeletedKeys(report.deleted)
  return { resolved, stillFailing }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Drop the index rows whose blob Rust just confirmed gone. */
async function dropRowsForDeletedKeys(cacheKeys: string[]): Promise<void> {
  if (cacheKeys.length === 0) return
  const db = getDb()
  const ids = await db.connectorAttachments.where("cacheKey").anyOf(cacheKeys).primaryKeys()
  if (ids.length > 0) await db.connectorAttachments.bulkDelete(ids as string[])
}

/** Push every unconfirmed delete into the retry ledger. */
async function ledgerFailures(
  report: AttachmentCleanupReport,
  adapterId?: string,
  reason: ConnectorAttachmentCleanupReason = "evicted"
): Promise<void> {
  for (const failure of report.failed) {
    await enqueueCleanupJob({
      cacheKey: failure.cacheKey,
      adapterId: adapterId ?? "",
      reason,
      error: failure.error,
    })
  }
}

type ConnectorAttachmentCleanupReason = Parameters<typeof enqueueCleanupJob>[0]["reason"]
