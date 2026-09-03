/** @jest-environment jsdom */
/**
 * Adoption of the pre-v219 machine-wide scheduler database.
 *
 * The behaviours worth pinning are the ones that lose data when they regress:
 * a legacy database we could not read must survive the attempt, the marker must
 * be written only after the rows are committed, and the two index
 * discriminators the old rows never had must be derived rather than left blank
 * (a blank one drops the task out of a lookup silently instead of erroring).
 */

import "fake-indexeddb/auto"
import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { LEGACY_SCHEDULER_DB_NAME } from "./scheduler-db"
import { migrateLegacySchedulerDatabase } from "./legacy-db-migration"

const LEGACY_STORES = {
  tasks:
    "id, name, type, status, nextRunAt, createdAt, projectId, [status+nextRunAt], [status+type], [status+eventType], [projectId+status]",
  executions: "id, taskId, status, startedAt, [taskId+startedAt]",
}

function legacyTaskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    id: "legacy-1",
    name: "Nightly digest",
    type: "chat",
    trigger: JSON.stringify({ type: "cron", cronExpression: "0 9 * * *" }),
    eventType: "",
    payload: JSON.stringify({ prompt: "summarise yesterday" }),
    config: JSON.stringify({ timeout: 1000, maxRetries: 0, retryDelay: 0 }),
    notification: JSON.stringify({ onStart: false, onComplete: true, onError: true }),
    createdBy: JSON.stringify({ kind: "user" }),
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

async function seedLegacyDatabase(rows: Record<string, unknown>[]): Promise<void> {
  const legacy = new Dexie(LEGACY_SCHEDULER_DB_NAME)
  legacy.version(5).stores(LEGACY_STORES)
  await legacy.open()
  await legacy.table("tasks").bulkAdd(rows)
  legacy.close()
}

describe("migrateLegacySchedulerDatabase", () => {
  beforeEach(async () => {
    const db = getDb()
    await db.scheduledTasks.clear()
    await db.scheduledTaskRuns.clear()
    await saveSettings({ schedulerLegacyDrainCompleted: undefined })
    await Dexie.delete(LEGACY_SCHEDULER_DB_NAME).catch(() => undefined)
  })

  it("does nothing, but records that it looked, when there is no legacy database", async () => {
    const result = await migrateLegacySchedulerDatabase({
      databaseExists: async () => false,
      deleteDatabase: async () => {
        throw new Error("must not delete when nothing was found")
      },
    })

    expect(result).toEqual({ migrated: false, tasks: 0, executions: 0 })
    // Recorded, so the next boot skips the existence probe entirely.
    expect((await getSettings()).schedulerLegacyDrainCompleted).toBe(true)
  })

  it("adopts rows and derives the discriminators the old schema never stored", async () => {
    await seedLegacyDatabase([
      // A row from before the creator column: no `createdBy` at all.
      legacyTaskRow({ id: "pre-v3", createdBy: undefined }),
      // A row from before the event index: `eventType` never populated.
      legacyTaskRow({
        id: "pre-v4",
        eventType: undefined,
        trigger: JSON.stringify({ type: "event", eventType: "job:exited" }),
      }),
      // An agent-authored row, which is what the per-source quota counts.
      legacyTaskRow({
        id: "by-agent",
        createdBy: JSON.stringify({ kind: "agent", sessionId: "s1" }),
      }),
    ])

    const deleted: string[] = []
    const result = await migrateLegacySchedulerDatabase({
      deleteDatabase: async (name) => {
        deleted.push(name)
      },
    })

    expect(result.migrated).toBe(true)
    expect(result.tasks).toBe(3)
    expect(deleted).toEqual([LEGACY_SCHEDULER_DB_NAME])

    const db = getDb()
    // Absent creator means user-authored: no agent or plugin creation surface
    // existed before the column, so the backfill is deterministic.
    expect((await db.scheduledTasks.get("pre-v3"))?.createdBySource).toBe("user")
    expect((await db.scheduledTasks.get("by-agent"))?.createdBySource).toBe("agent")
    // Derived from the trigger blob, so the row still answers an event lookup.
    expect((await db.scheduledTasks.get("pre-v4"))?.eventType).toBe("job:exited")
    expect((await db.scheduledTasks.get("pre-v3"))?.eventType).toBe("")
  })

  it("leaves an unreadable legacy database in place rather than destroying it", async () => {
    await seedLegacyDatabase([legacyTaskRow({ id: "unreachable" })])

    let deleteAttempted = false
    const result = await migrateLegacySchedulerDatabase({
      readLegacy: async () => {
        throw new Error("VersionError: database is at a newer version")
      },
      deleteDatabase: async () => {
        deleteAttempted = true
      },
    })

    expect(result.migrated).toBe(false)
    // Not deleted and not marked, so a fixed build gets to try again.
    expect(deleteAttempted).toBe(false)
    expect((await getSettings()).schedulerLegacyDrainCompleted).toBeFalsy()
    expect(await Dexie.exists(LEGACY_SCHEDULER_DB_NAME)).toBe(true)
  })

  it("skips a second run once this account has been drained", async () => {
    await saveSettings({ schedulerLegacyDrainCompleted: true })
    let probed = false

    const result = await migrateLegacySchedulerDatabase({
      databaseExists: async () => {
        probed = true
        return true
      },
    })

    expect(result.migrated).toBe(false)
    // The marker short-circuits BEFORE the probe. A delete that failed after a
    // successful drain would otherwise make this account adopt the same
    // schedules a second time.
    expect(probed).toBe(false)
  })

  it("keeps the adopted rows when the legacy database cannot be deleted", async () => {
    await seedLegacyDatabase([legacyTaskRow({ id: "kept" })])

    const result = await migrateLegacySchedulerDatabase({
      deleteDatabase: async () => {
        throw new Error("blocked by another connection")
      },
    })

    // Cosmetic failure only: the rows are already committed and the account is
    // marked, so boot must not be taken down by it.
    expect(result).toMatchObject({ migrated: true, tasks: 1, deleteFailed: true })
    expect(await getDb().scheduledTasks.get("kept")).toBeDefined()
    expect((await getSettings()).schedulerLegacyDrainCompleted).toBe(true)
  })
})
