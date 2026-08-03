jest.mock("@/lib/db/seed", () => ({
  seedBuiltIns: jest.fn().mockResolvedValue(undefined),
}))

import { getDb, type BackgroundTaskJournalRow } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  clearSettledBackgroundTasks,
  createDexieBackgroundTaskJournal,
  getBackgroundTaskRecord,
  interruptBackgroundTasksOnBoot,
  listBackgroundTaskRecords,
  pruneBackgroundTaskRecords,
} from "./background-tasks"

function row(overrides: Partial<BackgroundTaskJournalRow> = {}): BackgroundTaskJournalRow {
  return {
    runId: "bg_1",
    kind: "subagent",
    subagentId: "reviewer",
    prompt: "check this",
    sessionId: "ses_1",
    host: "renderer",
    status: "running",
    startedAt: 1000,
    ...overrides,
  }
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().backgroundTasks.clear()
})
afterAll(dbFixture.dispose)

describe("background task journal table", () => {
  it("is registered in the latest Dexie schema", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(87)
    expect(db.backgroundTasks).toBeDefined()
  })

  it("round-trips start and settle transitions through the journal adapter", async () => {
    const journal = createDexieBackgroundTaskJournal()

    await journal.recordStart(row())
    await journal.recordSettle("bg_1", {
      status: "done",
      settledAt: 2000,
      resultText: "finished",
      usage: { inputTokens: 3, outputTokens: 5 },
    })

    await expect(getBackgroundTaskRecord("bg_1")).resolves.toMatchObject({
      runId: "bg_1",
      status: "done",
      resultText: "finished",
      usage: { inputTokens: 3, outputTokens: 5 },
    })
    await expect(listBackgroundTaskRecords({ host: "renderer" })).resolves.toHaveLength(1)
  })

  it("marks running rows interrupted on boot without touching settled history", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "running", status: "running" }),
      row({ runId: "done", status: "done", settledAt: 1500, resultText: "ok" }),
    ])

    const flipped = await interruptBackgroundTasksOnBoot({ now: () => 3000 })

    await expect(getBackgroundTaskRecord("running")).resolves.toMatchObject({
      status: "interrupted",
      settledAt: 3000,
    })
    await expect(getBackgroundTaskRecord("done")).resolves.toMatchObject({
      status: "done",
      resultText: "ok",
    })
    // Returns only THIS boot's transitions so auto-resume never replays stale history.
    expect(flipped).toEqual([
      expect.objectContaining({ runId: "running", status: "interrupted", settledAt: 3000 }),
    ])
  })

  it("persists the optional journal extensions (mode/delivery/resume lineage)", async () => {
    const journal = createDexieBackgroundTaskJournal()

    await journal.recordStart(
      row({
        mode: "background",
        toolsEnabled: false,
        resumeOfRunId: "bg_0",
        resumeAttempt: 2,
        pluginId: "p1",
        label: "sweeper",
      })
    )
    await journal.update("bg_1", {
      status: "done",
      settledAt: 2000,
      resultText: "ok",
      collectedAt: 2500,
      deliveryState: "pending",
      resumedByRunId: "bg_2",
    })

    await expect(getBackgroundTaskRecord("bg_1")).resolves.toMatchObject({
      mode: "background",
      toolsEnabled: false,
      resumeOfRunId: "bg_0",
      resumeAttempt: 2,
      pluginId: "p1",
      label: "sweeper",
      collectedAt: 2500,
      deliveryState: "pending",
      resumedByRunId: "bg_2",
    })
  })

  it("clears settled history while preserving running rows", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "running", status: "running" }),
      row({ runId: "error", status: "error", settledAt: 2000, error: "boom" }),
      row({ runId: "interrupted", status: "interrupted", settledAt: 3000 }),
    ])

    await clearSettledBackgroundTasks()

    await expect(listBackgroundTaskRecords()).resolves.toEqual([
      expect.objectContaining({ runId: "running", status: "running" }),
    ])
  })

  it("clears settled history for one host without deleting the other host", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "renderer-done", host: "renderer", status: "done", settledAt: 2000 }),
      row({ runId: "cli-done", host: "cli", status: "done", settledAt: 2000 }),
    ])

    await clearSettledBackgroundTasks({ host: "renderer" })

    await expect(listBackgroundTaskRecords()).resolves.toEqual([
      expect.objectContaining({ runId: "cli-done", host: "cli", status: "done" }),
    ])
  })
})

describe("pruneBackgroundTaskRecords", () => {
  const DAY = 24 * 60 * 60 * 1000

  it("drops settled rows past maxAge but never running rows", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "old-running", status: "running", startedAt: 0 }),
      row({ runId: "old-done", status: "done", startedAt: 0, settledAt: 1000 }),
      row({ runId: "fresh-done", status: "done", startedAt: 20 * DAY, settledAt: 20 * DAY }),
    ])

    const removed = await pruneBackgroundTaskRecords({ now: 21 * DAY, maxAgeMs: 14 * DAY })

    expect(removed).toBe(1)
    const remaining = await listBackgroundTaskRecords()
    expect(remaining.map((r) => r.runId).sort()).toEqual(["fresh-done", "old-running"])
  })

  it("uses startedAt for age when a row never settled", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "stale-interrupted", status: "interrupted", startedAt: 0 }),
    ])

    const removed = await pruneBackgroundTaskRecords({ now: 15 * DAY, maxAgeMs: 14 * DAY })

    expect(removed).toBe(1)
    await expect(listBackgroundTaskRecords()).resolves.toEqual([])
  })

  it("trims the settled backlog to the newest maxItems", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "s1", status: "done", startedAt: 1000, settledAt: 1100 }),
      row({ runId: "s2", status: "done", startedAt: 2000, settledAt: 2100 }),
      row({ runId: "s3", status: "done", startedAt: 3000, settledAt: 3100 }),
      row({ runId: "live", status: "running", startedAt: 500 }),
    ])

    const removed = await pruneBackgroundTaskRecords({ now: 4000, maxAgeMs: 0, maxItems: 2 })

    expect(removed).toBe(1)
    const remaining = await listBackgroundTaskRecords()
    expect(remaining.map((r) => r.runId).sort()).toEqual(["live", "s2", "s3"])
  })

  it("scopes pruning to a host when given one", async () => {
    const db = getDb()
    await db.backgroundTasks.bulkPut([
      row({ runId: "renderer-old", host: "renderer", status: "done", startedAt: 0, settledAt: 0 }),
      row({ runId: "cli-old", host: "cli", status: "done", startedAt: 0, settledAt: 0 }),
    ])

    await pruneBackgroundTaskRecords({ now: 30 * DAY, host: "renderer" })

    await expect(listBackgroundTaskRecords()).resolves.toEqual([
      expect.objectContaining({ runId: "cli-old" }),
    ])
  })
})
