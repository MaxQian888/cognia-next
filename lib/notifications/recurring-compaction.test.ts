/**
 * @jest-environment jsdom
 */

import type { NotificationRecord } from "@/types/notifications"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { isMaintenanceTask } from "@/lib/scheduler/maintenance-tasks"
import {
  __resetRecurringCompactionForTesting,
  compactRecurringNotifications,
  ensureRecurringNotificationsCompacted,
  planRecurringCompaction,
  recurringIdentityOf,
  type CompactionDeps,
  type CompactionTask,
} from "./recurring-compaction"

const NOW = 1_000_000

function rec(over: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: "n",
    source: "scheduler",
    level: "success",
    title: "Task Completed: X",
    createdAt: 1,
    updatedAt: 1,
    readState: "unseen",
    count: 1,
    directed: false,
    deliveredVia: ["center"],
    ...over,
  }
}

const interval = (type: string, tags?: string[]): CompactionTask =>
  ({ type, tags, trigger: { type: "interval", intervalMs: 300_000 } }) as CompactionTask

describe("recurringIdentityOf", () => {
  it("maps legacy per-execution and current task keys to one identity", () => {
    expect(recurringIdentityOf({ dedupeKey: "task:t1:complete:exec-9" })).toEqual({
      key: "task:t1:complete",
      taskId: "t1",
      event: "complete",
    })
    expect(recurringIdentityOf({ dedupeKey: "task:t1:complete" })?.key).toBe("task:t1:complete")
    expect(recurringIdentityOf({ dedupeKey: "task:t1:auto-paused:e" })?.event).toBe("auto-paused")
  })

  it("maps pet due reminders and ignores everything else", () => {
    expect(recurringIdentityOf({ dedupeKey: "pet-scheduled-due:t2" })).toEqual({
      key: "pet-scheduled-due:t2",
      taskId: "t2",
      event: "due",
    })
    expect(recurringIdentityOf({ dedupeKey: "run:abc:terminal" })).toBeUndefined()
    expect(recurringIdentityOf({ dedupeKey: "webdav-remote-newer:5" })).toBeUndefined()
    expect(recurringIdentityOf({})).toBeUndefined()
  })
})

describe("planRecurringCompaction", () => {
  const plan = (records: NotificationRecord[], tasks: Record<string, CompactionTask> = {}) =>
    planRecurringCompaction({
      records,
      now: NOW,
      tasks: new Map(Object.entries(tasks)),
      isMaintenanceTask,
    })

  it("keeps the newest unread row per task event, folds counts, and archives the rest", () => {
    const patches = plan(
      [
        rec({ id: "a", dedupeKey: "task:t1:complete:e1", updatedAt: 10 }),
        rec({ id: "b", dedupeKey: "task:t1:complete:e2", updatedAt: 30, count: 2 }),
        rec({ id: "c", dedupeKey: "task:t1:complete:e3", updatedAt: 20 }),
      ],
      { t1: interval("plugin") }
    )
    const byId = Object.fromEntries(patches.map((entry) => [entry.id, entry.patch]))
    expect(byId.b).toEqual({ count: 4, dedupeKey: "task:t1:complete" })
    expect(byId.a).toMatchObject({ readState: "done", meta: { coalescedInto: "b" } })
    expect(byId.c).toMatchObject({ readState: "done", doneAt: NOW })
  })

  it("keeps failures separate from completions and leaves them unread", () => {
    const patches = plan(
      [
        rec({ id: "ok1", dedupeKey: "task:t1:complete:e1", updatedAt: 1 }),
        rec({ id: "ok2", dedupeKey: "task:t1:complete:e2", updatedAt: 2 }),
        rec({ id: "f1", dedupeKey: "task:t1:error:e3", updatedAt: 3, level: "error" }),
        rec({ id: "f2", dedupeKey: "task:t1:error:e4", updatedAt: 4, level: "error" }),
      ],
      { t1: interval("connection:presence:refresh") }
    )
    const byId = Object.fromEntries(patches.map((entry) => [entry.id, entry.patch]))
    // Maintenance routine success: survivor marked read.
    expect(byId.ok2).toMatchObject({ count: 2, readState: "read" })
    expect(byId.ok1.readState).toBe("done")
    // Maintenance failure: folded, but the survivor stays unread.
    expect(byId.f2).toEqual({ count: 2, dedupeKey: "task:t1:error" })
    expect(byId.f1.readState).toBe("done")
  })

  it("marks a lone routine maintenance row read without archiving it", () => {
    const patches = plan([rec({ id: "only", dedupeKey: "task:p:complete", updatedAt: 5 })], {
      p: interval("provider-diagnostics-refresh"),
    })
    expect(patches).toEqual([
      {
        id: "only",
        expectedUpdatedAt: 5,
        patch: expect.objectContaining({ readState: "read", lastReadAt: NOW }),
      },
    ])
  })

  it("folds pet due reminders per task and keeps a user task's survivor unread", () => {
    const patches = plan(
      [
        rec({ id: "d1", dedupeKey: "pet-scheduled-due:u", updatedAt: 1, directed: true }),
        rec({ id: "d2", dedupeKey: "pet-scheduled-due:u", updatedAt: 2, directed: true }),
      ],
      { u: interval("plugin", ["plugin:demo-heartbeat"]) }
    )
    const byId = Object.fromEntries(patches.map((entry) => [entry.id, entry.patch]))
    expect(byId.d2).toEqual({ count: 2 })
    expect(byId.d1.readState).toBe("done")
  })

  it("does not touch read, archived, or snoozed rows, or unrelated sources", () => {
    const patches = plan([
      rec({ id: "r", dedupeKey: "task:t:complete:1", readState: "read" }),
      rec({ id: "x", dedupeKey: "task:t:complete:2", readState: "done" }),
      rec({ id: "z", dedupeKey: "task:t:complete:3", snoozedUntil: NOW + 1 }),
      rec({ id: "m", dedupeKey: "conv:1", source: "connector" }),
    ])
    expect(patches).toEqual([])
  })

  it("keeps a one-shot task's per-execution rows apart", () => {
    const patches = plan(
      [
        rec({ id: "o1", dedupeKey: "task:once:complete:e1", updatedAt: 1 }),
        rec({ id: "o2", dedupeKey: "task:once:complete:e2", updatedAt: 2 }),
      ],
      { once: { type: "plugin", trigger: { type: "once" } } as CompactionTask }
    )
    expect(patches).toEqual([])
  })

  it("still folds rows of a task that no longer exists", () => {
    const patches = plan([
      rec({ id: "g1", dedupeKey: "task:gone:complete:e1", updatedAt: 1 }),
      rec({ id: "g2", dedupeKey: "task:gone:complete:e2", updatedAt: 2 }),
    ])
    expect(patches.map((entry) => entry.id).sort()).toEqual(["g1", "g2"])
  })
})

describe("compactRecurringNotifications", () => {
  it("survives a task lookup failure and reports what it changed", async () => {
    const applied: unknown[] = []
    const deps: CompactionDeps = {
      now: () => NOW,
      listUnread: async () => [
        rec({ id: "a", dedupeKey: "task:t:complete:1", updatedAt: 1 }),
        rec({ id: "b", dedupeKey: "task:t:complete:2", updatedAt: 2 }),
      ],
      getTask: async () => {
        throw new Error("scheduler db locked")
      },
      isMaintenanceTask,
      applyPatches: async (patches) => {
        applied.push(...patches)
        return patches.length
      },
    }
    await expect(compactRecurringNotifications(deps)).resolves.toEqual({
      archived: 1,
      updated: 1,
    })
    expect(applied).toHaveLength(2)
  })

  it("runs once per process and never rejects", async () => {
    __resetRecurringCompactionForTesting()
    const listUnread = jest.fn(async () => {
      throw new Error("boom")
    })
    const deps = {
      now: () => NOW,
      listUnread,
      getTask: async () => undefined,
      isMaintenanceTask,
      applyPatches: async () => 0,
    }
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    await expect(ensureRecurringNotificationsCompacted(deps)).resolves.toEqual({
      archived: 0,
      updated: 0,
    })
    await ensureRecurringNotificationsCompacted(deps)
    expect(listUnread).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    __resetRecurringCompactionForTesting()
  })
})

describe("ensureRecurringNotificationsCompacted (Dexie)", () => {
  const dbFixture = createDbTestFixture()
  beforeAll(dbFixture.initialize)
  beforeEach(() => {
    __resetRecurringCompactionForTesting()
    return dbFixture.restore()
  })
  afterAll(dbFixture.dispose)

  it("folds the stored backlog and leaves unrelated rows alone", async () => {
    const table = getDb().notifications
    const due = (id: string, updatedAt: number) =>
      rec({
        id,
        dedupeKey: "pet-scheduled-due:u1",
        updatedAt,
        createdAt: updatedAt,
        directed: true,
      })
    await table.bulkPut([
      due("d1", 1),
      due("d2", 2),
      due("d3", 3),
      rec({ id: "keep", dedupeKey: "conv:1", source: "connector", updatedAt: 4 }),
    ])

    const result = await ensureRecurringNotificationsCompacted({
      now: () => NOW,
      listUnread: () => table.where("readState").anyOf("unseen", "seen").toArray(),
      getTask: async () => interval("plugin"),
      isMaintenanceTask,
      applyPatches: async (patches) => {
        let written = 0
        await getDb().transaction("rw", table, async () => {
          for (const entry of patches) written += await table.update(entry.id, entry.patch)
        })
        return written
      },
    })

    expect(result).toEqual({ archived: 2, updated: 1 })
    const unread = await table.where("readState").anyOf("unseen", "seen").toArray()
    expect(unread.map((row) => row.id).sort()).toEqual(["d3", "keep"])
    expect((await table.get("d3"))?.count).toBe(3)
    // Archived, not deleted.
    expect((await table.get("d1"))?.readState).toBe("done")
    expect(await table.count()).toBe(4)
  })
})
