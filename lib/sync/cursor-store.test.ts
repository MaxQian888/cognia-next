/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

import { clearCursors, loadCursors, saveCursor } from "./cursor-store"
import type { SyncCursorRow } from "./types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("loadCursors", () => {
  it("returns an empty map when no rows are persisted", async () => {
    const map = await loadCursors()
    expect(map.size).toBe(0)
  })

  it("returns every persisted row keyed by table", async () => {
    const rows: SyncCursorRow[] = [
      { table: "characters", since: 10, lastSyncAt: 1_700_000_000_000, lastError: null },
      { table: "messages", since: 42, lastSyncAt: 1_700_000_000_500, lastError: "x" },
    ]
    await getDb().syncCursors.bulkPut(rows)

    const map = await loadCursors()

    expect(map.size).toBe(2)
    expect(map.get("characters")?.since).toBe(10)
    expect(map.get("messages")?.lastError).toBe("x")
  })

  it("returns empty when Dexie throws", async () => {
    const original = getDb().syncCursors.toArray
    getDb().syncCursors.toArray = jest.fn().mockRejectedValueOnce(new Error("boom"))

    const map = await loadCursors()

    expect(map.size).toBe(0)
    getDb().syncCursors.toArray = original
  })
})

describe("saveCursor", () => {
  it("upserts a row by &table primary key", async () => {
    await saveCursor({
      table: "sessions",
      since: 5,
      lastSyncAt: 1_700_000_000_000,
      lastError: null,
    })
    await saveCursor({
      table: "sessions",
      since: 9,
      lastSyncAt: 1_700_000_000_999,
      lastError: null,
    })

    const all = await getDb().syncCursors.toArray()
    expect(all).toHaveLength(1)
    expect(all[0]?.since).toBe(9)
    expect(all[0]?.lastSyncAt).toBe(1_700_000_000_999)
  })

  it("never throws when Dexie rejects", async () => {
    const original = getDb().syncCursors.put
    getDb().syncCursors.put = jest.fn().mockRejectedValueOnce(new Error("quota"))

    await expect(
      saveCursor({ table: "skills", since: 1, lastSyncAt: 1, lastError: null })
    ).resolves.toBeUndefined()

    getDb().syncCursors.put = original
  })
})

describe("clearCursors", () => {
  it("removes every persisted row", async () => {
    await getDb().syncCursors.bulkPut([
      { table: "characters", since: 1, lastSyncAt: 1, lastError: null },
      { table: "messages", since: 2, lastSyncAt: 2, lastError: null },
    ])

    await clearCursors()

    const remaining = await getDb().syncCursors.count()
    expect(remaining).toBe(0)
  })

  it("never throws when Dexie rejects", async () => {
    const original = getDb().syncCursors.clear
    getDb().syncCursors.clear = jest.fn().mockRejectedValueOnce(new Error("locked"))

    await expect(clearCursors()).resolves.toBeUndefined()

    getDb().syncCursors.clear = original
  })
})
