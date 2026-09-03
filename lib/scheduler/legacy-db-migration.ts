/**
 * One-shot drain of the pre-v219 standalone scheduler database.
 *
 * Before schema v219 the scheduler kept its own Dexie database,
 * `CogniaSchedulerDB`. It had no account dimension at all: one schedule was
 * shared by every account on the machine, stored in the clear. v219 folds the
 * two stores into the account database, so the old rows have to be moved.
 *
 * The honest limitation, stated once here and logged at runtime: **the legacy
 * database cannot say which account its rows belonged to, because it never
 * knew.** They therefore land in whichever account is active the first time
 * this runs after the upgrade. That is a real decision with a visible
 * consequence, so it is written to the log with the account id rather than
 * happening silently. A user with several accounts who finds a schedule in the
 * wrong one can move it, which is strictly better than us guessing per row.
 *
 * Idempotent by construction: success deletes the legacy database, and a
 * completion marker in the account database keeps a second account from
 * re-draining a database that a `deleteDatabase` failure left behind.
 */

import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import { getSettings, saveSettings } from "@/lib/db/settings"
import type { DBScheduledTask, DBTaskExecution } from "@/lib/db/scheduled-task-types"
import { loggers } from "@cognia/logging"

import {
  LEGACY_SCHEDULER_DB_NAME,
  createdBySourceFromSerializedCreator,
  eventTypeFromSerializedTrigger,
} from "./scheduler-db"

const log = loggers.app

export interface LegacySchedulerMigrationResult {
  /** Whether a legacy database was found and drained on this call. */
  migrated: boolean
  tasks: number
  executions: number
  /** Set when the legacy database was drained but could not be deleted. */
  deleteFailed?: boolean
}

const NOT_MIGRATED: LegacySchedulerMigrationResult = { migrated: false, tasks: 0, executions: 0 }

export interface LegacySchedulerMigrationDeps {
  /** Injected in tests. Defaults to `Dexie.exists`. */
  databaseExists?: (name: string) => Promise<boolean>
  /** Injected in tests. Defaults to `Dexie.delete`. */
  deleteDatabase?: (name: string) => Promise<void>
  /**
   * Read the legacy stores. Injected in tests because the failure that matters
   * here (a legacy database we cannot read, whose rows are the user's only
   * copy) cannot be provoked through Dexie's public surface: asking for a lower
   * version than the one on disk opens in dynamic mode instead of throwing. An
   * error branch that cannot be exercised is an error branch nobody has ever
   * run, so it gets a seam.
   */
  readLegacy?: () => Promise<{ tasks: DBScheduledTask[]; executions: DBTaskExecution[] }>
}

/**
 * Legacy rows lack `createdBySource`, and very old ones may lack `eventType`.
 * Both are index discriminators, and a row missing one drops silently out of
 * the lookups that use it rather than failing loudly, so derive them here.
 */
function adoptTaskRow(row: DBScheduledTask): DBScheduledTask {
  return {
    ...row,
    eventType: row.eventType ?? eventTypeFromSerializedTrigger(row.trigger),
    createdBySource: row.createdBySource ?? createdBySourceFromSerializedCreator(row.createdBy),
  }
}

/** Open the legacy database at the shape v5 left behind and read both stores. */
async function readLegacyStores(): Promise<{
  tasks: DBScheduledTask[]
  executions: DBTaskExecution[]
}> {
  const legacy = new Dexie(LEGACY_SCHEDULER_DB_NAME)
  legacy.version(5).stores({
    tasks:
      "id, name, type, status, nextRunAt, createdAt, projectId, [status+nextRunAt], [status+type], [status+eventType], [projectId+status]",
    executions: "id, taskId, status, startedAt, [taskId+startedAt]",
  })
  try {
    await legacy.open()
    return {
      tasks: await legacy.table<DBScheduledTask, string>("tasks").toArray(),
      executions: await legacy.table<DBTaskExecution, string>("executions").toArray(),
    }
  } finally {
    legacy.close()
  }
}

/**
 * Drain `CogniaSchedulerDB` into the active account database, then delete it.
 *
 * Call once at scheduler startup, before anything reads the schedule. Returns
 * what it moved so the caller can log or surface it.
 */
export async function migrateLegacySchedulerDatabase(
  deps: LegacySchedulerMigrationDeps = {}
): Promise<LegacySchedulerMigrationResult> {
  const databaseExists = deps.databaseExists ?? ((name: string) => Dexie.exists(name))
  const deleteDatabase = deps.deleteDatabase ?? ((name: string) => Dexie.delete(name))

  const db = getDb()

  // Checked first and cheaply: a machine that upgraded long ago pays one
  // settings read per boot rather than a `Dexie.exists` probe.
  const settings = await getSettings().catch(() => undefined)
  if (settings?.schedulerLegacyDrainCompleted) return NOT_MIGRATED

  if (!(await databaseExists(LEGACY_SCHEDULER_DB_NAME).catch(() => false))) {
    // Nothing to drain. Record that so later boots skip the probe too.
    await saveSettings({ schedulerLegacyDrainCompleted: true }).catch(() => undefined)
    return NOT_MIGRATED
  }

  let tasks: DBScheduledTask[] = []
  let executions: DBTaskExecution[] = []
  try {
    const raw = await (deps.readLegacy ?? readLegacyStores)()
    tasks = raw.tasks.map(adoptTaskRow)
    executions = raw.executions
  } catch (error) {
    // A legacy database we cannot read must NOT be deleted, and must NOT be
    // marked done. Leaving it in place is what makes a fixed build able to
    // retry. The schedule it holds is the user's only copy.
    log.error(
      `[scheduler] legacy database found but unreadable, leaving it in place: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return NOT_MIGRATED
  }

  // `bulkPut`, not `bulkAdd`: a partially-completed earlier attempt must be
  // able to finish rather than collide on ids it already wrote.
  await db.transaction("rw", [db.scheduledTasks, db.scheduledTaskRuns], async () => {
    if (tasks.length > 0) await db.scheduledTasks.bulkPut(tasks)
    if (executions.length > 0) await db.scheduledTaskRuns.bulkPut(executions)
  })
  // Written only after the rows are committed. The reverse order would let a
  // failed write leave the account marked done with nothing adopted.
  await saveSettings({ schedulerLegacyDrainCompleted: true })

  log.info(
    `[scheduler] adopted ${tasks.length} schedule(s) and ${executions.length} run(s) from the legacy ` +
      `machine-wide database into account database "${db.name}". The legacy database had no account ` +
      `dimension, so these now belong to this account. Move any that belong elsewhere.`
  )

  let deleteFailed = false
  try {
    await deleteDatabase(LEGACY_SCHEDULER_DB_NAME)
  } catch (error) {
    // The rows are already safe in the account database and the marker is
    // written, so this is cosmetic. Say so rather than failing the boot.
    deleteFailed = true
    log.warn(
      `[scheduler] legacy database drained but could not be deleted: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  return { migrated: true, tasks: tasks.length, executions: executions.length, deleteFailed }
}
