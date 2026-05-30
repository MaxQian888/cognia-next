/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"

import {
  __resetInstalledForTests,
  installDesktopSyncSource,
  readDexieDelta,
} from "./desktop-sync-source"

describe("readDexieDelta", () => {
  beforeEach(async () => {
    __resetInstalledForTests()
    // Wipe the tables we touch.
    const db = getDb()
    await db.characters.clear()
    await db.skills.clear()
    await db.sessions.clear()
    await db.messages.clear()
    await db.conversationOverrides.clear()
    await db.settings.clear()
    await db.syncTombstones.clear()
  })

  it("returns characters whose updatedAt > since", async () => {
    const db = getDb()
    await db.characters.bulkPut([
      { id: "c1", name: "old", systemPrompt: "x", createdAt: 0, updatedAt: 5 } as never,
      { id: "c2", name: "new", systemPrompt: "x", createdAt: 0, updatedAt: 50 } as never,
    ])
    const delta = await readDexieDelta("characters", 10)
    expect(delta.rows).toHaveLength(1)
    expect(delta.next_since).toBe(50)
    expect(delta.deleted_ids).toEqual([])
  })

  it("returns sessions whose updatedAt > since", async () => {
    const db = getDb()
    await db.sessions.bulkPut([
      { id: "s1", title: "old", kind: "direct", createdAt: 0, updatedAt: 1 } as never,
      { id: "s2", title: "new", kind: "direct", createdAt: 0, updatedAt: 10 } as never,
    ])
    const delta = await readDexieDelta("sessions", 5)
    expect(delta.rows.map((r) => (r as { id: string }).id)).toEqual(["s2"])
    expect(delta.next_since).toBe(10)
  })

  it("pages messages by [createdAt+id], ascending, under the page size", async () => {
    const db = getDb()
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `m${String(i).padStart(4, "0")}`,
      sessionId: "s",
      createdAt: i + 1,
      updatedAt: i + 1,
    })) as never[]
    await db.messages.bulkPut(rows)

    const delta = await readDexieDelta("messages", 0)
    // Full history (250 < page size 500) now syncs — no global 200 cap.
    expect(delta.rows).toHaveLength(250)
    const first = delta.rows[0] as { createdAt: number }
    const last = delta.rows[delta.rows.length - 1] as { createdAt: number }
    expect(last.createdAt - first.createdAt).toBeGreaterThan(0)
    expect(delta.next_since).toBe(250)
    expect(delta.has_more).toBe(false)
  })

  it("sets has_more when a page fills to capacity", async () => {
    const db = getDb()
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `m${String(i).padStart(4, "0")}`,
      sessionId: "s",
      createdAt: i + 1,
      updatedAt: i + 1,
    })) as never[]
    await db.messages.bulkPut(rows)

    const delta = await readDexieDelta("messages", 0)
    expect(delta.rows).toHaveLength(500)
    expect(delta.has_more).toBe(true)
  })

  it("surfaces tombstones as deleted_ids and folds deletedAt into next_since", async () => {
    const db = getDb()
    await db.sessions.bulkPut([
      { id: "s1", title: "live", kind: "direct", createdAt: 0, updatedAt: 5 } as never,
    ])
    await db.syncTombstones.bulkPut([
      { table: "sessions", id: "sGone", deletedAt: 80 },
      { table: "sessions", id: "sOld", deletedAt: 1 }, // before the cursor
      { table: "messages", id: "mGone", deletedAt: 90 }, // other table
    ])
    const delta = await readDexieDelta("sessions", 2)
    expect(delta.rows.map((r) => (r as { id: string }).id)).toEqual(["s1"])
    expect(delta.deleted_ids).toEqual(["sGone"])
    // next_since = max(maxUpdatedAt=5, maxDeletedAt=80)
    expect(delta.next_since).toBe(80)
  })

  it("returns conversationOverrides whose updatedAt > since", async () => {
    const db = getDb()
    await db.conversationOverrides.bulkPut([
      { id: "o1", conversationKey: "k1", updatedAt: 3 } as never,
      { id: "o2", conversationKey: "k2", updatedAt: 30 } as never,
    ])
    const delta = await readDexieDelta("conversationOverrides", 10)
    expect(delta.rows.map((r) => (r as { id: string }).id)).toEqual(["o2"])
    expect(delta.next_since).toBe(30)
  })

  it("emits the settings singleton on first pull and re-emits after a change", async () => {
    const db = getDb()
    await db.settings.put({ id: "singleton", theme: "dark", updatedAt: 100 } as never)

    // First pull (since 0) always warms the cache.
    const first = await readDexieDelta("settings", 0)
    expect(first.rows).toHaveLength(1)
    expect(first.next_since).toBe(100)

    // A pull at the current cursor returns nothing…
    const steady = await readDexieDelta("settings", 100)
    expect(steady.rows).toHaveLength(0)

    // …until the row changes (new updatedAt), then it re-emits.
    await db.settings.put({ id: "singleton", theme: "light", updatedAt: 150 } as never)
    const afterChange = await readDexieDelta("settings", 100)
    expect(afterChange.rows).toHaveLength(1)
    expect(afterChange.next_since).toBe(150)
  })

  it("filters skills by updatedAt", async () => {
    const db = getDb()
    await db.skills.bulkPut([
      { id: "k1", name: "a", createdAt: 0, updatedAt: 0 } as never,
      { id: "k2", name: "b", createdAt: 0, updatedAt: 100 } as never,
    ])
    const delta = await readDexieDelta("skills", 50)
    expect(delta.rows).toHaveLength(1)
    expect((delta.rows[0] as { id: string }).id).toBe("k2")
  })

  it("throws on an unknown table", async () => {
    await expect(readDexieDelta("unknown" as never, 0)).rejects.toThrow(/unknown sync table/)
  })
})

describe("installDesktopSyncSource", () => {
  beforeEach(() => {
    __resetInstalledForTests()
  })

  it("calls the response command with delta on a successful pull", async () => {
    const listenHandler: { ref: ((e: { payload: unknown }) => void) | null } = { ref: null }
    const listen = jest.fn(async (_event: string, h: (e: { payload: unknown }) => void) => {
      listenHandler.ref = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    const teardown = await installDesktopSyncSource({
      bridge: { listen, invoke },
      forceReinstall: true,
    })

    // Wipe + seed characters.
    const db = getDb()
    await db.characters.clear()
    await db.characters.put({
      id: "c1",
      name: "x",
      systemPrompt: "y",
      createdAt: 0,
      updatedAt: 99,
    } as never)

    listenHandler.ref!({ payload: { request_id: "rid-1", table: "characters", since: 0 } })
    // Wait for the async handler to invoke back.
    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenCalledWith("companion_sync_pull_response", {
      requestId: "rid-1",
      delta: expect.objectContaining({
        rows: expect.arrayContaining([expect.objectContaining({ id: "c1" })]),
        next_since: 99,
      }),
      error: null,
    })

    teardown()
  })

  it("calls the response command with error on a failing pull", async () => {
    const listenHandler: { ref: ((e: { payload: unknown }) => void) | null } = { ref: null }
    const listen = jest.fn(async (_event: string, h: (e: { payload: unknown }) => void) => {
      listenHandler.ref = h
      return () => {}
    })
    const invoke = jest.fn(async () => ({}))

    await installDesktopSyncSource({
      bridge: { listen, invoke },
      forceReinstall: true,
    })

    listenHandler.ref!({
      payload: { request_id: "rid-2", table: "bogus" as never, since: 0 },
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(invoke).toHaveBeenCalledWith("companion_sync_pull_response", {
      requestId: "rid-2",
      delta: null,
      error: expect.stringContaining("unknown sync table"),
    })
  })

  it("returns a no-op teardown when the Tauri imports fail (web/Capacitor)", async () => {
    // Force the dynamic-import path; jest can't resolve @tauri-apps/api/event
    // in jsdom, so the loader rejects — but we passed a bridge so this test
    // exercises the second-call short-circuit.
    const teardown1 = await installDesktopSyncSource({
      bridge: { listen: async () => () => {}, invoke: async () => ({}) },
      forceReinstall: true,
    })
    const teardown2 = await installDesktopSyncSource({
      bridge: { listen: async () => () => {}, invoke: async () => ({}) },
      forceReinstall: false,
    })
    // Second call returns a no-op (does not re-listen).
    teardown2()
    teardown1()
  })
})
