/**
 * Enqueue points for the background memory sweeps — `vector-reconcile` (ADR-0069
 * round 2) and `project-claim-revalidate`.
 *
 * The vector handler existed in `job-worker.ts` but nothing ever enqueued it, so
 * the vector collection silently drifted from Dexie whenever a best-effort
 * upsert/delete failed. Both sweeps live here so that class of "handler with no
 * caller" is visible in one file.
 *
 * Two vector triggers:
 * - `enqueueDailyVectorReconcile` — day-bucketed dedupe key, called from the
 *   post-turn maintenance scheduler; at most one sweep per day.
 * - `noteMemoryVectorFailure` — call from every best-effort vector catch; the
 *   third failure since the last sweep enqueues an immediate reconcile.
 *
 * Both are fire-safe: enqueue failures are swallowed (the daily trigger will
 * retry) and the worker loop drains the job like any other.
 */

import { enqueueMemoryJob } from "@/lib/db/memory-governance"

const FAILURES_PER_RECONCILE = 3

let vectorFailureCount = 0

/** Test hook. */
export function __resetVectorFailureCount(): void {
  vectorFailureCount = 0
}

async function enqueueReconcile(dedupeKey: string): Promise<void> {
  try {
    await enqueueMemoryJob(
      {
        dedupeKey,
        kind: "vector-reconcile",
        scope: "global",
        provenance: "system",
        evidenceIds: [],
      },
      { reuseCompleted: true }
    )
  } catch {
    // Best-effort — the daily trigger retries tomorrow.
  }
}

/** At most one drift sweep per calendar day (UTC bucket). */
export async function enqueueDailyVectorReconcile(now: number = Date.now()): Promise<void> {
  const dayBucket = new Date(now).toISOString().slice(0, 10)
  await enqueueReconcile(`vector-reconcile:${dayBucket}`)
}

/**
 * Record one failed best-effort vector upsert/delete. Every third failure
 * enqueues an immediate reconcile (unique key per burst so a completed daily
 * sweep doesn't dedupe it away).
 */
export function noteMemoryVectorFailure(now: number = Date.now()): void {
  vectorFailureCount += 1
  if (vectorFailureCount < FAILURES_PER_RECONCILE) return
  vectorFailureCount = 0
  void enqueueReconcile(`vector-reconcile:failures:${now}`)
}

/**
 * Re-check one claim, because something that claim depended on just changed.
 *
 * This is the PRIMARY path — the daily sweep only catches what it missed (a
 * crash between a message deletion and this call). Keyed by memory id so a burst
 * of deletions touching the same claim collapses to one job, and NOT
 * `reuseCompleted`: unlike a transcript window, a claim can need re-checking
 * many times over its life, and reusing yesterday's completed row would make
 * every deletion after the first a no-op.
 */
export async function enqueueClaimRevalidation(memoryId: string): Promise<void> {
  if (!memoryId) return
  try {
    await enqueueMemoryJob({
      dedupeKey: `project-claim-revalidate:${memoryId}`,
      kind: "project-claim-revalidate",
      memoryId,
      scope: "workspace",
      provenance: "system",
      evidenceIds: [],
    })
  } catch {
    // Best-effort — the daily sweep is the backstop.
  }
}

/** At most one shallow claim sweep per calendar day (UTC bucket). */
export async function enqueueDailyClaimRevalidation(now: number = Date.now()): Promise<void> {
  const dayBucket = new Date(now).toISOString().slice(0, 10)
  try {
    await enqueueMemoryJob(
      {
        dedupeKey: `project-claim-revalidate:sweep:${dayBucket}`,
        kind: "project-claim-revalidate",
        scope: "workspace",
        provenance: "system",
        evidenceIds: [],
      },
      { reuseCompleted: true }
    )
  } catch {
    // Best-effort — tomorrow's tick retries.
  }
}
