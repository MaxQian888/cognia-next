/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

import { clearCursors, clearCursorsForServer, loadCursors, saveCursor } from "./cursor-store"
import type { SyncCursorRow } from "./types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("loadCursors", () => {
  it("returns an empty map when no rows are persisted", async () => {
    const map = await loadCursors("host-a")
    expect(map.size).toBe(0)
  })

  it("returns every persisted row for that host, keyed by table", async () => {
    const rows: SyncCursorRow[] = [
      {
        serverKey: "host-a",
        table: "characters",
        since: 10,
        lastSyncAt: 1_700_000_000_000,
        lastError: null,
      },
      {
        serverKey: "host-a",
        table: "messages",
        since: 42,
        lastSyncAt: 1_700_000_000_500,
        lastError: "x",
      },
    ]
    await getDb().hostSyncCursors.bulkPut(rows)

    const map = await loadCursors("host-a")

    expect(map.size).toBe(2)
    expect(map.get("characters")?.since).toBe(10)
    expect(map.get("messages")?.lastError).toBe("x")
  })

  it("never returns another host's watermark", async () => {
    // The bug this partitioning exists for: resuming from a cursor that belongs
    // to a different machine asks the new host for "everything since <a
    // timestamp that means nothing here>".
    await getDb().hostSyncCursors.bulkPut([
      { serverKey: "host-a", table: "messages", since: 999, lastSyncAt: 1, lastError: null },
    ])

    expect((await loadCursors("host-b")).size).toBe(0)
    expect((await loadCursors("host-a")).get("messages")?.since).toBe(999)
  })

  it("returns empty when Dexie throws", async () => {
    const original = getDb().hostSyncCursors.toArray
    getDb().hostSyncCursors.toArray = jest.fn().mockRejectedValueOnce(new Error("boom"))

    const map = await loadCursors("host-a")

    expect(map.size).toBe(0)
    getDb().hostSyncCursors.toArray = original
  })
})

describe("saveCursor", () => {
  it("upserts a row by the [serverKey+table] primary key", async () => {
    await saveCursor({
      serverKey: "host-a",
      table: "sessions",
      since: 5,
      lastSyncAt: 1_700_000_000_000,
      lastError: null,
    })
    await saveCursor({
      serverKey: "host-a",
      table: "sessions",
      since: 9,
      lastSyncAt: 1_700_000_000_999,
      lastError: null,
    })

    const all = await getDb().hostSyncCursors.toArray()
    expect(all).toHaveLength(1)
    expect(all[0]?.since).toBe(9)
    expect(all[0]?.lastSyncAt).toBe(1_700_000_000_999)
  })

  it("keeps the same table's cursors for two hosts side by side", async () => {
    await saveCursor({
      serverKey: "host-a",
      table: "sessions",
      since: 5,
      lastSyncAt: 1,
      lastError: null,
    })
    await saveCursor({
      serverKey: "host-b",
      table: "sessions",
      since: 77,
      lastSyncAt: 2,
      lastError: null,
    })

    expect(await getDb().hostSyncCursors.count()).toBe(2)
    expect((await loadCursors("host-a")).get("sessions")?.since).toBe(5)
    expect((await loadCursors("host-b")).get("sessions")?.since).toBe(77)
  })

  it("never throws when Dexie rejects", async () => {
    const original = getDb().hostSyncCursors.put
    getDb().hostSyncCursors.put = jest.fn().mockRejectedValueOnce(new Error("quota"))

    await expect(
      saveCursor({ serverKey: "host-a", table: "skills", since: 1, lastSyncAt: 1, lastError: null })
    ).resolves.toBeUndefined()

    getDb().hostSyncCursors.put = original
  })
})

describe("clearCursors", () => {
  it("removes every persisted row", async () => {
    await getDb().hostSyncCursors.bulkPut([
      { serverKey: "host-a", table: "characters", since: 1, lastSyncAt: 1, lastError: null },
      { serverKey: "host-b", table: "messages", since: 2, lastSyncAt: 2, lastError: null },
    ])

    await clearCursors()

    const remaining = await getDb().hostSyncCursors.count()
    expect(remaining).toBe(0)
  })

  it("never throws when Dexie rejects", async () => {
    const original = getDb().hostSyncCursors.clear
    getDb().hostSyncCursors.clear = jest.fn().mockRejectedValueOnce(new Error("locked"))

    await expect(clearCursors()).resolves.toBeUndefined()

    getDb().hostSyncCursors.clear = original
  })
})

describe("clearCursorsForServer", () => {
  it("removes one host's rows and leaves the others", async () => {
    await getDb().hostSyncCursors.bulkPut([
      { serverKey: "host-a", table: "characters", since: 1, lastSyncAt: 1, lastError: null },
      { serverKey: "host-b", table: "messages", since: 2, lastSyncAt: 2, lastError: null },
    ])

    await clearCursorsForServer("host-a")

    const remaining = await getDb().hostSyncCursors.toArray()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.serverKey).toBe("host-b")
  })

  it("never throws when Dexie rejects", async () => {
    const original = getDb().hostSyncCursors.where
    getDb().hostSyncCursors.where = jest.fn(() => {
      throw new Error("locked")
    }) as never

    await expect(clearCursorsForServer("host-a")).resolves.toBeUndefined()

    getDb().hostSyncCursors.where = original
  })
})
