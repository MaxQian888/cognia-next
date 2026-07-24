/**
 * Enqueue points for the `vector-reconcile` memory job (ADR-0069 round 2).
 * The handler existed in `job-worker.ts` but nothing ever enqueued it, so the
 * vector collection silently drifted from Dexie whenever a best-effort
 * upsert/delete failed.
 *
 * Two triggers:
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
