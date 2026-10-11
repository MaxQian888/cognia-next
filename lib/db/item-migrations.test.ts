/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  advanceItemMigration,
  getItemMigration,
  latestItemMigration,
  listHostItemMigrations,
  listItemMigrations,
  listUnfinishedItemMigrations,
  putItemMigration,
  type ItemMigrationRow,
} from "./item-migrations"
import { __resetDbForTesting, getDb } from "./schema"

function row(overrides: Partial<ItemMigrationRow> = {}): ItemMigrationRow {
  return {
    operationId: "op-1",
    direction: "move",
    itemKind: "scheduled-task",
    itemId: "task-1",
    itemLabel: "Morning digest",
    hostId: "mini",
    hostLabel: "Mac mini",
    localStatus: "active",
    state: "prepared",
    history: [{ state: "prepared", at: 1 }],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

beforeEach(async () => {
  __resetDbForTesting()
  await getDb().itemMigrations.clear()
}, 15_000)

describe("item migration journal", () => {
  it("records each step in order and remembers the host's id once known", async () => {
    await putItemMigration(row())
    await advanceItemMigration("op-1", { state: "created", remoteItemId: "task-1" }, 2)
    const next = await advanceItemMigration("op-1", { state: "fenced", detail: "placeholder" }, 3)
    expect(next).toMatchObject({ state: "fenced", remoteItemId: "task-1", updatedAt: 3 })
    expect(next.history).toEqual([
      { state: "prepared", at: 1 },
      { state: "created", at: 2 },
      { state: "fenced", at: 3, detail: "placeholder" },
    ])
    expect(await getItemMigration("op-1")).toEqual(next)
  })

  it("keeps a failure's resume point until the operation moves on", async () => {
    await putItemMigration(row())
    const failed = await advanceItemMigration("op-1", {
      state: "failed",
      resumeFrom: "created",
      error: "host did not answer",
    })
    expect(failed).toMatchObject({ resumeFrom: "created", error: "host did not answer" })
    const resumed = await advanceItemMigration("op-1", { state: "fenced" })
    expect(resumed.error).toBeUndefined()
    expect(resumed.resumeFrom).toBeUndefined()
  })

  it("refuses to advance an operation it never recorded", async () => {
    await expect(advanceItemMigration("op-missing", { state: "created" })).rejects.toThrow(
      /item_migration_missing/
    )
  })

  it("lists by item, by host and what is still unfinished", async () => {
    await putItemMigration(
      row({ operationId: "op-1", state: "completed", createdAt: 1, updatedAt: 5 })
    )
    await putItemMigration(
      row({
        operationId: "op-2",
        direction: "take-back",
        state: "awaiting-host",
        createdAt: 2,
        updatedAt: 6,
      })
    )
    await putItemMigration(
      row({
        operationId: "op-3",
        itemId: "task-2",
        hostId: "vps",
        state: "failed",
        createdAt: 3,
        updatedAt: 4,
      })
    )
    expect(
      (await listItemMigrations("scheduled-task", "task-1")).map((r) => r.operationId)
    ).toEqual(["op-1", "op-2"])
    expect((await latestItemMigration("scheduled-task", "task-1"))?.operationId).toBe("op-2")
    expect(await latestItemMigration("bot-installation", "task-1")).toBeUndefined()
    expect((await listHostItemMigrations("mini")).map((r) => r.operationId)).toEqual([
      "op-2",
      "op-1",
    ])
    expect((await listUnfinishedItemMigrations()).map((r) => r.operationId)).toEqual([
      "op-2",
      "op-3",
    ])
  })
})
