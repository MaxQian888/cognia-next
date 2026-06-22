import type {
  BackgroundTaskJournal,
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
  patch: Partial<
    Pick<BackgroundTaskJournalRow, "status" | "settledAt" | "resultText" | "error" | "usage">
  >
): Promise<void> {
  await updateBackgroundTaskRecord(runId, patch)
}

export async function updateBackgroundTaskRecord(
  runId: string,
  patch: Partial<
    Pick<BackgroundTaskJournalRow, "status" | "settledAt" | "resultText" | "error" | "usage">
  >
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

export async function interruptBackgroundTasksOnBoot(
  options: { now?: () => number } = {}
): Promise<void> {
  await interruptRunningTasks(createDexieBackgroundTaskJournal(), options)
}
