/**
 * Storage port for video jobs.
 *
 * The engine runs in two hosts: the app renderer, where jobs live in Dexie
 * (`lib/db/media-generation-jobs.ts`) and survive reloads, and the CLI, which
 * has no IndexedDB and keeps them in memory for the life of the process. The
 * host (`host.ts`) picks the store.
 */

import type { MediaGenerationJobRow, VideoJobStatus } from "./types"

export interface MediaJobStore {
  insert(row: MediaGenerationJobRow): Promise<void>
  get(id: string): Promise<MediaGenerationJobRow | undefined>
  /**
   * Atomically move a job from `from` to `to` and apply `patch`. Returns the
   * updated row, or `undefined` when the job is missing or no longer in
   * `from` — the guard that keeps two windows from both downloading.
   */
  transition(
    id: string,
    from: VideoJobStatus,
    to: VideoJobStatus,
    patch?: Partial<MediaGenerationJobRow>
  ): Promise<MediaGenerationJobRow | undefined>
  /** Patch a job that is still in `status`; returns the updated row. */
  update(
    id: string,
    status: VideoJobStatus,
    patch: Partial<MediaGenerationJobRow>
  ): Promise<MediaGenerationJobRow | undefined>
  /** Jobs in `status` whose `nextPollAt <= now`, oldest first. */
  listDue(status: VideoJobStatus, now: number): Promise<MediaGenerationJobRow[]>
  /** Every job in `status`. */
  listByStatus(status: VideoJobStatus): Promise<MediaGenerationJobRow[]>
}

export function createInMemoryMediaJobStore(): MediaJobStore {
  const rows = new Map<string, MediaGenerationJobRow>()

  const apply = (
    id: string,
    guard: VideoJobStatus,
    next: VideoJobStatus,
    patch: Partial<MediaGenerationJobRow>
  ): MediaGenerationJobRow | undefined => {
    const row = rows.get(id)
    if (!row || row.status !== guard) return undefined
    const updated: MediaGenerationJobRow = { ...row, ...patch, id: row.id, status: next }
    rows.set(id, updated)
    return updated
  }

  return {
    async insert(row) {
      if (rows.has(row.id)) throw new Error(`video job ${row.id} already exists`)
      rows.set(row.id, row)
    },
    async get(id) {
      return rows.get(id)
    },
    async transition(id, from, to, patch = {}) {
      return apply(id, from, to, patch)
    },
    async update(id, status, patch) {
      return apply(id, status, status, patch)
    },
    async listDue(status, now) {
      return [...rows.values()]
        .filter((row) => row.status === status && row.nextPollAt <= now)
        .sort((a, b) => a.nextPollAt - b.nextPollAt)
    },
    async listByStatus(status) {
      return [...rows.values()].filter((row) => row.status === status)
    },
  }
}
