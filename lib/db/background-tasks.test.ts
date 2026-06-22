/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

jest.mock("@/lib/db/seed", () => ({
  seedBuiltIns: jest.fn().mockResolvedValue(undefined),
}))

import { __resetDbForTesting, getDb, whenSeeded, type BackgroundTaskJournalRow } from "./schema"
import {
  clearSettledBackgroundTasks,
  createDexieBackgroundTaskJournal,
  getBackgroundTaskRecord,
  interruptBackgroundTasksOnBoot,
  listBackgroundTaskRecords,
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

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().backgroundTasks.clear()
})

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

    await interruptBackgroundTasksOnBoot({ now: () => 3000 })

    await expect(getBackgroundTaskRecord("running")).resolves.toMatchObject({
      status: "interrupted",
      settledAt: 3000,
    })
    await expect(getBackgroundTaskRecord("done")).resolves.toMatchObject({
      status: "done",
      resultText: "ok",
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
