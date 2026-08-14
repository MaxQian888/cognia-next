/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"

import {
  recordTombstones,
  readTombstonesSince,
  pruneTombstones,
  TOMBSTONE_RETENTION_MS,
} from "./tombstones"

describe("tombstones", () => {
  beforeEach(async () => {
    await getDb().syncTombstones.clear()
  })

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

  it("prunes tombstones older than the retention window", async () => {
    const now = 1_000_000_000_000
    await recordTombstones("sessions", ["old"], now - TOMBSTONE_RETENTION_MS - 1)
    await recordTombstones("sessions", ["fresh"], now - 1000)
    await pruneTombstones(TOMBSTONE_RETENTION_MS, now)
    const rows = await getDb().syncTombstones.toArray()
    expect(rows.map((r) => r.id)).toEqual(["fresh"])
  })
})
