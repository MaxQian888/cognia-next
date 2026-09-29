/**
 * Dexie adapter for the video job store port (ADR-0205, schema v234).
 *
 * The row type lives with its engine (`lib/ai/media/video-jobs/types.ts`);
 * this module owns persistence: the status-guarded transition that keeps two
 * windows from downloading the same video, the reconciler's due-job query,
 * and the retention prune.
 */

import type { MediaJobStore } from "@/lib/ai/media/video-jobs/store"
import {
  isSettledVideoJob,
  type MediaGenerationJobRow,
  type VideoJobStatus,
} from "@/lib/ai/media/video-jobs/types"
import { getDb } from "./schema"

/** Settled statuses the retention sweep may prune; `succeeded` follows its session. */
const PRUNABLE_VIDEO_JOB_STATUSES: readonly VideoJobStatus[] = ["failed", "cancelled", "timed_out"]

async function guarded(
  id: string,
  from: VideoJobStatus,
  to: VideoJobStatus,
  patch: Partial<MediaGenerationJobRow>
): Promise<MediaGenerationJobRow | undefined> {
  const db = getDb()
  return db.transaction("rw", db.mediaGenerationJobs, async () => {
    const row = await db.mediaGenerationJobs.get(id)
    if (!row || row.status !== from) return undefined
    const updated: MediaGenerationJobRow = { ...row, ...patch, id: row.id, status: to }
    // `put`, not `update`: a patch value of `undefined` must clear the field.
    for (const key of Object.keys(updated) as (keyof MediaGenerationJobRow)[]) {
      if (updated[key] === undefined) delete updated[key]
    }
    await db.mediaGenerationJobs.put(updated)
    return updated
  })
}

export function createDexieMediaJobStore(): MediaJobStore {
  return {
    async insert(row) {
      await getDb().mediaGenerationJobs.add(row)
    },
    async get(id) {
      return getDb().mediaGenerationJobs.get(id)
    },
    transition(id, from, to, patch = {}) {
      return guarded(id, from, to, patch)
    },
    update(id, status, patch) {
      return guarded(id, status, status, patch)
    },
    async listDue(status, now) {
      return getDb()
        .mediaGenerationJobs.where("[status+nextPollAt]")
        .between([status, -Infinity], [status, now], true, true)
        .toArray()
    },
    async listByStatus(status) {
      return getDb().mediaGenerationJobs.where("status").equals(status).toArray()
    },
  }
}

/** Jobs a conversation started, newest first. */
export async function listSessionVideoJobs(sessionId: string): Promise<MediaGenerationJobRow[]> {
  const rows = await getDb()
    .mediaGenerationJobs.where("[sessionId+createdAt]")
    .between([sessionId, -Infinity], [sessionId, Infinity])
    .toArray()
  return rows.reverse()
}

/**
 * Retention executor: drop failed / cancelled / timed-out jobs settled before
 * `cutoff`. Succeeded jobs are kept — their video lives with the session (or
 * in Files) and is removed with it.
 */
export async function pruneSettledVideoJobs(cutoff: number): Promise<number> {
  const db = getDb()
  return db.mediaGenerationJobs
    .where("settledAt")
    .below(cutoff)
    .filter((row) => PRUNABLE_VIDEO_JOB_STATUSES.includes(row.status))
    .delete()
}

/**
 * Whether a job travels in a backup. Only settled jobs: an in-flight job
 * belongs to the device polling it. A session-bound job goes when its session
 * is exported; any other job goes with the core data.
 */
export function isPortableVideoJob(
  row: MediaGenerationJobRow,
  scope: { includeCoreData: boolean; exportedSessionIds: ReadonlySet<string> }
): boolean {
  if (!isSettledVideoJob(row)) return false
  return row.sessionId ? scope.exportedSessionIds.has(row.sessionId) : scope.includeCoreData
}

/** Point a restored job at the session ids a duplicate restore assigned. */
export function remapVideoJobSession(
  row: MediaGenerationJobRow,
  sessionMapping: ReadonlyMap<string, string>
): MediaGenerationJobRow {
  const mapped = row.sessionId ? sessionMapping.get(row.sessionId) : undefined
  if (!mapped) return row
  const content = row.result?.content
  return {
    ...row,
    sessionId: mapped,
    origin:
      row.origin.surface === "chat-tool" || row.origin.surface === "slash"
        ? { ...row.origin, sessionId: mapped }
        : row.origin,
    ...(row.result && content?.kind === "session-asset"
      ? { result: { ...row.result, content: { ...content, sessionId: mapped } } }
      : {}),
  }
}
