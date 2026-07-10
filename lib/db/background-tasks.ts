import type {
  BackgroundTaskJournal,
  BackgroundTaskJournalPatch,
  BackgroundTaskJournalRecord,
  BackgroundTaskStatus,
} from "@/lib/background-tasks/registry-core"
import { interruptRunningTasks } from "@/lib/background-tasks/registry-core"
import { getDb } from "./schema"

export type BackgroundTaskJournalRow = BackgroundTaskJournalRecord

export interface BackgroundTaskListFilter {
  host?: BackgroundTaskJournalRow["host"]
  status?: BackgroundTaskStatus
}

export async function recordBackgroundTaskStart(row: BackgroundTaskJournalRow): Promise<void> {
  await getDb().backgroundTasks.put(row)
}

export async function recordBackgroundTaskSettle(
  runId: string,
  patch: BackgroundTaskJournalPatch
): Promise<void> {
  await updateBackgroundTaskRecord(runId, patch)
}

export async function updateBackgroundTaskRecord(
  runId: string,
  patch: BackgroundTaskJournalPatch
): Promise<void> {
  await getDb().backgroundTasks.update(runId, patch)
}

export async function getBackgroundTaskRecord(
  runId: string
): Promise<BackgroundTaskJournalRow | undefined> {
  return getDb().backgroundTasks.get(runId)
}

export async function listBackgroundTaskRecords(
  filter: BackgroundTaskListFilter = {}
): Promise<BackgroundTaskJournalRow[]> {
  const db = getDb()
  let rows: BackgroundTaskJournalRow[]
  if (filter.host && filter.status) {
    rows = await db.backgroundTasks
      .where("[host+status]")
      .equals([filter.host, filter.status])
      .toArray()
  } else if (filter.host) {
    rows = await db.backgroundTasks.where("host").equals(filter.host).toArray()
  } else if (filter.status) {
    rows = await db.backgroundTasks.where("status").equals(filter.status).toArray()
  } else {
    rows = await db.backgroundTasks.toArray()
  }
  return rows.sort((a, b) => b.startedAt - a.startedAt)
}

export async function clearSettledBackgroundTasks(
  filter: BackgroundTaskListFilter = {}
): Promise<void> {
  const db = getDb()
  const rows = await listBackgroundTaskRecords(filter)
  const settled = rows.filter((row) => row.status !== "running").map((row) => row.runId)
  if (settled.length > 0) await db.backgroundTasks.bulkDelete(settled)
}

export function createDexieBackgroundTaskJournal(): BackgroundTaskJournal {
  return {
    recordStart: recordBackgroundTaskStart,
    recordSettle: recordBackgroundTaskSettle,
    list: listBackgroundTaskRecords,
    get: getBackgroundTaskRecord,
    update: updateBackgroundTaskRecord,
    clearSettled: clearSettledBackgroundTasks,
  }
}

/**
 * Boot reconciliation: flip orphaned `running` rows to `interrupted`. Returns
 * the freshly transitioned rows so opt-in auto-resume can act on THIS boot's
 * interruptions only (stale interrupted history is never re-dispatched).
 */
export async function interruptBackgroundTasksOnBoot(
  options: { now?: () => number } = {}
): Promise<BackgroundTaskJournalRow[]> {
  return interruptRunningTasks(createDexieBackgroundTaskJournal(), options)
}

/** Default retention for settled journal rows (age + cap; running rows never pruned). */
export const BACKGROUND_TASK_PRUNE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const BACKGROUND_TASK_PRUNE_MAX_ITEMS = 200

/**
 * Prune settled journal rows, modeled on `pruneNotifications`: drop rows whose
 * settle (or start, for settle-less rows) is older than `maxAgeMs`, then trim
 * to the newest `maxItems`. `running` rows are never pruned. Returns the
 * number of rows removed.
 */
export async function pruneBackgroundTaskRecords(opts: {
  now: number
  maxAgeMs?: number
  maxItems?: number
  host?: BackgroundTaskJournalRow["host"]
}): Promise<number> {
  const maxAgeMs = opts.maxAgeMs ?? BACKGROUND_TASK_PRUNE_MAX_AGE_MS
  const maxItems = opts.maxItems ?? BACKGROUND_TASK_PRUNE_MAX_ITEMS
  const db = getDb()
  let removed = 0
  await db.transaction("rw", db.backgroundTasks, async () => {
    const rows = await listBackgroundTaskRecords(opts.host ? { host: opts.host } : {})
    const settled = rows.filter((row) => row.status !== "running")
    const doomed = new Set<string>()
    if (maxAgeMs > 0) {
      const cutoff = opts.now - maxAgeMs
      for (const row of settled) {
        if ((row.settledAt ?? row.startedAt) < cutoff) doomed.add(row.runId)
      }
    }
    if (maxItems > 0) {
      // listBackgroundTaskRecords sorts newest-first by startedAt.
      const survivors = settled.filter((row) => !doomed.has(row.runId))
      for (const row of survivors.slice(maxItems)) doomed.add(row.runId)
    }
    if (doomed.size > 0) {
      await db.backgroundTasks.bulkDelete([...doomed])
      removed = doomed.size
    }
  })
  return removed
}
