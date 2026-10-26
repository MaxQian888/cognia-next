/**
 * The Files Trash purge (ADR-0223): a scheduler maintenance task that ends
 * every item trashed more than `FILES_TRASH_RETENTION_MS` ago, by the rule in
 * `./trash.ts`.
 *
 * A scheduled task rather than a sweep when Files opens: a trashed item keeps
 * its bytes pinned, so they count against the asset quota until the purge. A
 * sweep that only ran on opening Files would hold them for as long as the
 * person stays away from it.
 *
 * Shaped like the conversation auto-archive sweep
 * (`lib/chat/auto-archive-schedule.ts`): the executor registration is separate
 * from the boot install, and a paired client whose Host owns the data skips —
 * the Host purges its own Trash; a client purging would act on a mirror.
 */

import { ensureMaintenanceSchedule } from "@/lib/scheduler/managed-tasks"
import { loggers } from "@cognia/logging"

import { listTrashedLibraryItemsBefore } from "@/lib/db/files-library-items"
import { FILES_TRASH_RETENTION_MS, type LibraryItemRow } from "@/lib/db/files-library-types"
import { hostOwnsSessionState } from "@/lib/db/mobile-outbound-queue"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { getTaskScheduler, registerTaskExecutor } from "@/lib/scheduler/task-scheduler"
import type { CreateScheduledTaskInput, ScheduledTaskType } from "@/types/scheduler"

import {
  purgeTrashedItems,
  resolveTrashPurgeTargets,
  type TrashPurgeOutcome,
  type TrashPurgeTarget,
} from "./trash"

const log = loggers.scheduler

export const FILES_TRASH_PURGE_TASK_TYPE = "files-trash-purge" satisfies ScheduledTaskType

/** Retention is thirty days, so a few hours of lag is invisible. */
export const FILES_TRASH_PURGE_INTERVAL_MS = 6 * 60 * 60_000

export const FILES_TRASH_PURGE_TASK_TAG = "system:files-trash"

// A type alias, not an interface: the run output is stored as a
// `Record<string, unknown>`, which only an alias satisfies structurally.
export type FilesTrashPurgeRunOutcome = {
  expired: number
  deleted: number
  retired: number
  /** Present when the purge did not look at the rows, and why. */
  skipped?: "host-owned"
}

export interface FilesTrashPurgeDependencies {
  now: () => number
  hostOwnsData: () => boolean
  listExpired: (cutoff: number) => Promise<LibraryItemRow[]>
  resolveTargets: (rows: readonly LibraryItemRow[]) => Promise<TrashPurgeTarget[]>
  purge: (targets: readonly TrashPurgeTarget[]) => Promise<TrashPurgeOutcome>
}

const DEFAULT_DEPENDENCIES: FilesTrashPurgeDependencies = {
  now: Date.now,
  hostOwnsData: () => hostOwnsSessionState(getRuntimeSnapshot()),
  listExpired: listTrashedLibraryItemsBefore,
  resolveTargets: resolveTrashPurgeTargets,
  purge: (targets) => purgeTrashedItems(targets),
}

/** One purge. Throws when a write fails, so the run is recorded as failed. */
export async function runFilesTrashPurge(
  dependencies: Partial<FilesTrashPurgeDependencies> = {}
): Promise<FilesTrashPurgeRunOutcome> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  if (deps.hostOwnsData()) {
    log.info("[FilesTrashPurge] skipped: the paired Host owns the Files library")
    return { expired: 0, deleted: 0, retired: 0, skipped: "host-owned" }
  }
  const expired = await deps.listExpired(deps.now() - FILES_TRASH_RETENTION_MS)
  if (expired.length === 0) return { expired: 0, deleted: 0, retired: 0 }
  const outcome = await deps.purge(await deps.resolveTargets(expired))
  log.info(
    `[FilesTrashPurge] purged ${expired.length} expired Trash item(s): ${outcome.deleted} deleted, ${outcome.retired} removed from Files`
  )
  return { expired: expired.length, ...outcome }
}

/** Register the scheduler executor; see `lib/scheduler/executor-owners.ts`. */
export function registerFilesTrashPurgeExecutor(): void {
  registerTaskExecutor(FILES_TRASH_PURGE_TASK_TYPE, async () => {
    try {
      return { success: true, output: await runFilesTrashPurge() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(`[FilesTrashPurge] purge failed: ${message}`)
      return { success: false, error: message }
    }
  })
}

/** Register the executor and make sure exactly one purge task exists. */
export async function installFilesTrashPurgeSchedule(): Promise<void> {
  registerFilesTrashPurgeExecutor()
  const scheduler = getTaskScheduler()
  const task: CreateScheduledTaskInput = {
    name: "Files Trash purge",
    type: FILES_TRASH_PURGE_TASK_TYPE,
    trigger: { type: "interval", intervalMs: FILES_TRASH_PURGE_INTERVAL_MS },
    // A missed purge loses nothing (the next one sees the same rows); one
    // catch-up run after a long offline stretch frees the space promptly.
    config: { runMissedOnStartup: true, catchupWindowMs: 24 * 60 * 60_000, maxMissedRuns: 1 },
    notification: {
      dueReminder: false,
      onStart: false,
      onComplete: false,
      onError: false,
      onProgress: false,
      channels: ["none"],
    },
    createdBy: { kind: "user" },
    tags: [FILES_TRASH_PURGE_TASK_TAG],
  }
  await ensureMaintenanceSchedule(scheduler, task)
}
