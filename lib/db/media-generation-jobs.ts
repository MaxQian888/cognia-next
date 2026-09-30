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

/** Settled statuses the retention sweep prunes whatever the job made. */
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
 * `cutoff`, and succeeded workflow jobs, whose video is a file of their own
 * (removed here through `removeFile`). Other succeeded jobs are kept — their
 * video lives with the session (or in Files) and is removed with it.
 */
export async function pruneSettledVideoJobs(
  cutoff: number,
  removeFile: (relativePath: string) => Promise<void>
): Promise<number> {
  const db = getDb()
  const rows = await db.mediaGenerationJobs
    .where("settledAt")
    .below(cutoff)
    .filter(
      (row) =>
        PRUNABLE_VIDEO_JOB_STATUSES.includes(row.status) ||
        (row.status === "succeeded" && row.result?.content.kind === "file")
    )
    .toArray()
  const pruned: string[] = []
  for (const row of rows) {
    const content = row.result?.content
    if (content?.kind === "file") {
      try {
        await removeFile(content.relativePath)
      } catch {
        // Keep the row, so the next sweep tries again rather than orphan the file.
        continue
      }
    }
    pruned.push(row.id)
  }
  await db.mediaGenerationJobs.bulkDelete(pruned)
  return pruned.length
}

/**
 * Whether a job travels in a backup. Only settled jobs: an in-flight job
 * belongs to the device polling it, and so does a workflow job's video, a
 * file on this device's disk the backup does not carry. A session-bound job
 * goes when its session is exported; any other job goes with the core data.
 */
export function isPortableVideoJob(
  row: MediaGenerationJobRow,
  scope: { includeCoreData: boolean; exportedSessionIds: ReadonlySet<string> }
): boolean {
  if (!isSettledVideoJob(row)) return false
  if (row.result?.content.kind === "file") return false
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
