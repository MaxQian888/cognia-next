/**
 * CRUD layer for the `twinJobs` Dexie table.
 *
 * Tracks ingest + distill workflows. The scheduler executor
 * (`lib/scheduler/executors/twin-distill-executor.ts`, Phase 4) picks queued
 * jobs FIFO via `claimNextQueuedJob`, runs them through the pipeline while
 * pumping `phase` + `progress` updates, and finalises with `completeJob` /
 * `failJob`. Workbench surfaces (Phase 7) subscribe to active jobs via
 * `useLiveQuery(listActiveJobsByTwin)` for real-time progress bars.
 */

import type { TwinJob, TwinJobKind, TwinJobStatus } from "@/types/twin"
import { getDb } from "./schema"

function newId(): string {
  return "twj_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/**
 * Lease window for a claimed job. The worker refreshes the lease on every
 * `updateJobProgress`, so this only needs to exceed the gap between progress
 * updates, not the whole job duration. A `running` row whose lease has lapsed
 * is assumed dead (tab closed / crashed mid-run) and is reclaimable.
 */
const LEASE_TTL_MS = 10 * 60 * 1000

export type TwinJobDraft = Omit<
  TwinJob,
  "id" | "queuedAt" | "status" | "phase" | "progress" | "retryCount"
> &
  Partial<Pick<TwinJob, "id" | "queuedAt" | "status" | "phase" | "progress" | "retryCount">>

export async function createTwinJob(draft: TwinJobDraft): Promise<TwinJob> {
  const row: TwinJob = {
    id: draft.id ?? newId(),
    twinId: draft.twinId,
    kind: draft.kind,
    sourceIds: draft.sourceIds,
    status: draft.status ?? "queued",
    phase: draft.phase ?? "queued",
    progress: draft.progress ?? 0,
    queuedAt: draft.queuedAt ?? Date.now(),
    startedAt: draft.startedAt,
    completedAt: draft.completedAt,
    errorMessage: draft.errorMessage,
    retryCount: draft.retryCount ?? 0,
    outputDraftIds: draft.outputDraftIds,
    llmTokensUsed: draft.llmTokensUsed,
    embeddingTokensUsed: draft.embeddingTokensUsed,
  }
  await getDb().twinJobs.add(row)
  return row
}

export async function getTwinJob(id: string): Promise<TwinJob | undefined> {
  return getDb().twinJobs.get(id)
}

export async function listTwinJobsByTwin(twinId: string): Promise<TwinJob[]> {
  return getDb().twinJobs.where("twinId").equals(twinId).reverse().sortBy("queuedAt")
}

export async function listJobsByTwinAndStatus(
  twinId: string,
  status: TwinJobStatus
): Promise<TwinJob[]> {
  return getDb().twinJobs.where(["twinId", "status"]).equals([twinId, status]).toArray()
}

export async function listJobsByTwinAndKind(twinId: string, kind: TwinJobKind): Promise<TwinJob[]> {
  return getDb().twinJobs.where(["twinId", "kind"]).equals([twinId, kind]).toArray()
}

export async function listActiveJobsByTwin(twinId: string): Promise<TwinJob[]> {
  // "active" = queued OR running OR paused. Two queries so we can use the
  // `[twinId+status]` compound index for both halves.
  const db = getDb()
  const [queued, running, paused] = await Promise.all([
    db.twinJobs.where(["twinId", "status"]).equals([twinId, "queued"]).toArray(),
    db.twinJobs.where(["twinId", "status"]).equals([twinId, "running"]).toArray(),
    db.twinJobs.where(["twinId", "status"]).equals([twinId, "paused"]).toArray(),
  ])
  return [...queued, ...running, ...paused].sort((a, b) => a.queuedAt - b.queuedAt)
}

/**
 * Pull the oldest queued job for a twin (FIFO scheduler). Atomic: marks
 * the picked job `running` inside a transaction so two concurrent
 * executors can't claim the same row.
 *
 * Skips jobs whose `nextAttemptAt` is in the future — those are queued
 * retries waiting out their backoff. Pass `now` as a deterministic clock
 * source for tests; production callers can leave it omitted.
 */
export async function claimNextQueuedJob(
  twinId?: string,
  now: number = Date.now()
): Promise<TwinJob | undefined> {
  const db = getDb()
  return db.transaction("rw", db.twinJobs, async () => {
    // Eligible = queued rows past their backoff, PLUS `running` rows whose
    // lease has expired — those belong to a worker that crashed mid-run and
    // never flipped the row terminal, so reclaim them rather than leave them
    // stuck "running" forever.
    const queued = twinId
      ? await db.twinJobs.where(["twinId", "status"]).equals([twinId, "queued"]).toArray()
      : await db.twinJobs.where("status").equals("queued").toArray()
    const stuck = twinId
      ? await db.twinJobs.where(["twinId", "status"]).equals([twinId, "running"]).toArray()
      : await db.twinJobs.where("status").equals("running").toArray()

    const eligible = [
      ...queued.filter((j) => (j.nextAttemptAt ?? 0) <= now),
      ...stuck.filter((j) => j.leaseExpiresAt !== undefined && j.leaseExpiresAt <= now),
    ].sort((a, b) => a.queuedAt - b.queuedAt)
    if (eligible.length === 0) return undefined

    const oldest = eligible[0]
    const claimed: TwinJob = {
      ...oldest,
      status: "running",
      phase: "starting",
      startedAt: Date.now(),
      leaseExpiresAt: now + LEASE_TTL_MS,
    }
    await db.twinJobs.put(claimed)
    return claimed
  })
}

/**
 * Release a claim the worker made but can't run right now because no
 * concurrency seat is free. Flips `running → queued` WITHOUT touching
 * `retryCount` or `nextAttemptAt` — seat contention is not a failure and must
 * not consume the job's retry budget the way {@link requeueJob} does. Clears
 * the lease.
 */
export async function releaseClaim(id: string): Promise<void> {
  await getDb().twinJobs.update(id, {
    status: "queued",
    phase: "queued",
    startedAt: undefined,
    leaseExpiresAt: undefined,
  })
}

export async function updateJobProgress(
  id: string,
  patch: { phase?: string; progress?: number }
): Promise<void> {
  // Refresh the lease on every progress tick so a healthy long-running job is
  // never reclaimed as stuck; only a worker that stops reporting loses it.
  await getDb().twinJobs.update(id, { ...patch, leaseExpiresAt: Date.now() + LEASE_TTL_MS })
}

export async function completeJob(
  id: string,
  patch: {
    outputDraftIds?: string[]
    llmTokensUsed?: number
    embeddingTokensUsed?: number
    partialFailures?: Record<string, string>
  } = {}
): Promise<void> {
  await getDb().twinJobs.update(id, {
    status: "completed",
    phase: "completed",
    progress: 100,
    completedAt: Date.now(),
    ...patch,
  })
}

export async function failJob(id: string, errorMessage: string): Promise<void> {
  const job = await getDb().twinJobs.get(id)
  await getDb().twinJobs.update(id, {
    status: "failed",
    errorMessage,
    completedAt: Date.now(),
    retryCount: (job?.retryCount ?? 0) + 1,
  })
}

/**
 * Requeue a transient failure for another attempt.
 *
 * Increments `retryCount`, flips `status` back to `queued`, and stores
 * `nextAttemptAt` so `claimNextQueuedJob` waits out the backoff. Clears
 * `errorMessage` so the workbench doesn't show stale failure text on a
 * row that's about to retry.
 */
export async function requeueJob(id: string, nextAttemptAt: number): Promise<void> {
  const job = await getDb().twinJobs.get(id)
  await getDb().twinJobs.update(id, {
    status: "queued",
    phase: "queued",
    progress: 0,
    errorMessage: undefined,
    startedAt: undefined,
    completedAt: undefined,
    retryCount: (job?.retryCount ?? 0) + 1,
    nextAttemptAt,
  })
}

/**
 * Pause a queued or running job. The worker treats `paused` as a terminal
 * state (won't claim, won't process) but keeps the row so the user can
 * resume later.
 */
export async function pauseJob(id: string): Promise<void> {
  await getDb().twinJobs.update(id, { status: "paused", phase: "paused" })
}

/** Resume a paused job — restores status to `queued`. */
export async function resumeJob(id: string): Promise<void> {
  await getDb().twinJobs.update(id, {
    status: "queued",
    phase: "queued",
    nextAttemptAt: undefined,
  })
}

/** Sentinel embedded in `errorMessage` when a user cancels a job. */
export const USER_CANCEL_SENTINEL = "[USER_CANCELLED]"

/**
 * User-initiated cancellation. Marks the row failed with a sentinel
 * prefix so the workbench can render it distinctly from a transient
 * error. Optional `reason` (e.g. "fingerprint mismatch") is appended to
 * the sentinel for the audit trail.
 */
export async function cancelJob(id: string, reason?: string): Promise<void> {
  const message = reason ? `${USER_CANCEL_SENTINEL} ${reason}` : USER_CANCEL_SENTINEL
  await getDb().twinJobs.update(id, {
    status: "failed",
    phase: "cancelled",
    errorMessage: message,
    completedAt: Date.now(),
  })
}

/**
 * User-initiated retry of a failed / dead-lettered job. Unlike
 * `requeueJob` (which the worker calls for transient failures with
 * backoff + incremented retryCount), this resets `retryCount` to zero
 * so the budget is fresh again. Clears the error message and any phase
 * / progress / attempt state so the row reads as "freshly queued" in
 * the UI; the worker will pick it up on the next tick.
 */
export async function retryDeadLetterJob(id: string): Promise<void> {
  await getDb().twinJobs.update(id, {
    status: "queued",
    phase: "queued",
    progress: 0,
    errorMessage: undefined,
    startedAt: undefined,
    completedAt: undefined,
    retryCount: 0,
    nextAttemptAt: undefined,
  })
}

/**
 * @deprecated Use `retryDeadLetterJob` — same behaviour, the name
 * matches both the dead-letter and transient-failure retry paths.
 */
export const retryFailedJob = retryDeadLetterJob

export async function deleteTwinJob(id: string): Promise<void> {
  await getDb().twinJobs.delete(id)
}
