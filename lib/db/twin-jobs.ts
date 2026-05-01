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
 */
export async function claimNextQueuedJob(twinId?: string): Promise<TwinJob | undefined> {
  const db = getDb()
  return db.transaction("rw", db.twinJobs, async () => {
    const candidates = twinId
      ? await db.twinJobs.where(["twinId", "status"]).equals([twinId, "queued"]).toArray()
      : await db.twinJobs.where("status").equals("queued").toArray()
    if (candidates.length === 0) return undefined
    const oldest = candidates.sort((a, b) => a.queuedAt - b.queuedAt)[0]
    const claimed: TwinJob = {
      ...oldest,
      status: "running",
      phase: "starting",
      startedAt: Date.now(),
    }
    await db.twinJobs.put(claimed)
    return claimed
  })
}

export async function updateJobProgress(
  id: string,
  patch: { phase?: string; progress?: number }
): Promise<void> {
  await getDb().twinJobs.update(id, patch)
}

export async function completeJob(
  id: string,
  patch: {
    outputDraftIds?: string[]
    llmTokensUsed?: number
    embeddingTokensUsed?: number
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

export async function deleteTwinJob(id: string): Promise<void> {
  await getDb().twinJobs.delete(id)
}
