/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import {
  recordTombstones,
  readTombstonesSince,
  pruneTombstones,
  TOMBSTONE_RETENTION_MS,
} from "./tombstones"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
afterEach(() => jest.restoreAllMocks())

describe("tombstones", () => {
  it("records one row per id with a shared timestamp", async () => {
    await recordTombstones("messages", ["m1", "m2"], 1000)
    const rows = await getDb().syncTombstones.where("table").equals("messages").toArray()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.deletedAt === 1000)).toBe(true)
  })

  it("keeps HostState generation and sequence on ordered deletions", async () => {
    await recordTombstones("sessions", ["ordered"], 1000, {
      generation: 3,
      sequence: 42,
    })
    await expect(getDb().syncTombstones.get(["sessions", "ordered"])).resolves.toMatchObject({
      hostGeneration: 3,
      hostSeq: 42,
    })
  })

  it("no-ops on an empty id list", async () => {
    await recordTombstones("messages", [])
    expect(await getDb().syncTombstones.count()).toBe(0)
  })

  it("is idempotent on the [table+id] primary key (latest wins)", async () => {
    await recordTombstones("sessions", ["s1"], 1)
    await recordTombstones("sessions", ["s1"], 2)
    const rows = await getDb().syncTombstones.where("table").equals("sessions").toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].deletedAt).toBe(2)
  })

  it("keeps the same id distinct across tables", async () => {
    await recordTombstones("sessions", ["dup"], 1)
    await recordTombstones("messages", ["dup"], 2)
    expect(await getDb().syncTombstones.count()).toBe(2)
  })

  it("reads only tombstones newer than since, scoped to the table", async () => {
    await recordTombstones("sessions", ["a"], 10)
    await recordTombstones("sessions", ["b"], 50)
    await recordTombstones("messages", ["c"], 99)
    const res = await readTombstonesSince("sessions", 20)
    expect(res.ids).toEqual(["b"])
    expect(res.maxDeletedAt).toBe(50)
  })

  it("returns `since` as maxDeletedAt when nothing is newer", async () => {
    await recordTombstones("sessions", ["a"], 5)
    const res = await readTombstonesSince("sessions", 10)
    expect(res.ids).toEqual([])
    expect(res.maxDeletedAt).toBe(10)
  })

  it("keeps deletions past an unfinished row page available for the next pull", async () => {
    await recordTombstones("messages", ["already-applied"], 10)
    await recordTombstones("messages", ["page-boundary"], 20)
    await recordTombstones("messages", ["later-deletion"], 30)
    await recordTombstones("sessions", ["other-table"], 15)
    expect(await readTombstonesSince("messages", 10, 20)).toEqual({
      ids: ["page-boundary"],
      maxDeletedAt: 20,
    })
    expect(await readTombstonesSince("messages", 20)).toEqual({
      ids: ["later-deletion"],
      maxDeletedAt: 30,
    })
  })

  it("prunes tombstones older than the retention window", async () => {
    const now = 1_000_000_000_000
    await recordTombstones("sessions", ["old"], now - TOMBSTONE_RETENTION_MS - 1)
    await recordTombstones("sessions", ["fresh"], now - 1000)
    await pruneTombstones(TOMBSTONE_RETENTION_MS, now)
    const rows = await getDb().syncTombstones.toArray()
    expect(rows.map((r) => r.id)).toEqual(["fresh"])
  })
})

describe("deleted session reconciliation before tombstone expiry", () => {
  async function seedChild(sessionId: string, hash = sessionId) {
    const db = getDb()
    await db.chatDrafts.put({ sessionId, text: "stale", updatedAt: 1, revision: 1 } as never)
    await db.sessionState.put({ sessionId, lastReadAt: 1, unreadCount: 0 })
    await db.chatInputHistory.put({
      id: sessionId,
      sessionId,
      text: "stale",
      createdAt: 1,
    } as never)
    await db.chatTurnSummaries.put({ sessionId, itemKey: "item", turnKey: "turn" } as never)
    await db.chatTranscriptIndexState.put({ sessionId } as never)
    await db.messageMediaRefs.put({ sessionId, messageId: sessionId, hash })
    await db.messageMedia.put({
      hash,
      createdAt: 1,
      blob: new Blob([hash]),
      byteSize: hash.length,
    } as never)
  }

  it("reclaims only explicitly deleted missing sessions, retaining live, optimistic and still-referenced data", async () => {
    const db = getDb()
    for (const id of ["deleted", "live", "optimistic", "pending-history", "shared-deleted"])
      await seedChild(id)
    await db.sessions.put({ id: "live", createdAt: 1, updatedAt: 1, title: "keep" } as never)
    await db.messages.put({
      id: "pending-history",
      sessionId: "pending-history",
      parts: [],
      createdAt: 1,
    } as never)
    await db.messageMediaRefs.put({
      sessionId: "elsewhere",
      messageId: "elsewhere",
      hash: "shared-deleted",
    })
    await recordTombstones("sessions", ["deleted", "live", "pending-history", "shared-deleted"], 1)
    const bulkBlobs = jest.spyOn(db.messageMedia, "bulkGet")
    await pruneTombstones(1000, 100000)
    expect(bulkBlobs).not.toHaveBeenCalled()
    for (const id of ["deleted", "shared-deleted"]) {
      expect(await db.chatDrafts.get(id)).toBeUndefined()
      expect(await db.sessionState.get(id)).toBeUndefined()
      expect(await db.chatInputHistory.where("sessionId").equals(id).count()).toBe(0)
      expect(await db.chatTurnSummaries.where("sessionId").equals(id).count()).toBe(0)
      expect(await db.chatTranscriptIndexState.get(id)).toBeUndefined()
      expect(await db.messageMediaRefs.where("sessionId").equals(id).count()).toBe(0)
    }
    for (const id of ["live", "optimistic", "pending-history"])
      expect(await db.chatDrafts.get(id)).toBeDefined()
    expect(await db.messageMedia.get("deleted")).toBeUndefined()
    expect(await db.messageMedia.get("shared-deleted")).toBeDefined()
  })

  it("keeps the deletion evidence and rows together on failure so the next sweep retries", async () => {
    const db = getDb()
    await seedChild("retry")
    await recordTombstones("sessions", ["retry"], 1)
    const fail = jest
      .spyOn(db.chatTranscriptIndexState, "bulkDelete")
      .mockRejectedValueOnce(new Error("injected cleanup failure"))
    await pruneTombstones(1000, 100000)
    expect(await db.syncTombstones.get(["sessions", "retry"])).toBeDefined()
    expect(await db.chatDrafts.get("retry")).toBeDefined()
    expect(await db.messageMediaRefs.where("sessionId").equals("retry").count()).toBe(1)
    expect(await db.messageMedia.get("retry")).toBeDefined()
    fail.mockRestore()
    await pruneTombstones(1000, 100000)
    expect(await db.chatDrafts.get("retry")).toBeUndefined()
    expect(await db.syncTombstones.get(["sessions", "retry"])).toBeUndefined()
  })

  it("processes more than one page and keeps recent media through the existing grace window", async () => {
    const db = getDb()
    const ids = Array.from(
      { length: 251 },
      (_, index) => `deleted-${String(index).padStart(3, "0")}`
    )
    await db.chatDrafts.bulkPut(
      ids.map((sessionId) => ({ sessionId, text: "old", updatedAt: 1, revision: 1 })) as never
    )
    await recordTombstones("sessions", ids, 1)
    await db.messageMediaRefs.put({ sessionId: ids[250], messageId: "recent", hash: "recent" })
    await db.messageMedia.put({
      hash: "recent",
      createdAt: 99999,
      blob: new Blob(["new"]),
    } as never)
    await pruneTombstones(1000, 100000)
    expect(await db.chatDrafts.count()).toBe(0)
    expect(await db.messageMedia.get("recent")).toBeDefined()
    expect(await db.syncTombstones.count()).toBe(1)
    await pruneTombstones(1000, 200000)
    expect(await db.messageMedia.get("recent")).toBeUndefined()
    expect(await db.syncTombstones.count()).toBe(0)
  })
})
