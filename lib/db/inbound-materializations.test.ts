/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  deleteInboundMaterialization,
  enqueueInboundMaterialization,
  getInboundMaterialization,
  listFailedMaterializations,
  listQueuedMaterializations,
  markMaterializationCompleted,
  markMaterializationFailed,
  markMaterializationRunning,
  retryMaterialization,
} from "./inbound-materializations"
import { getDb } from "./schema"

beforeEach(async () => {
  await getDb().inboundMaterializations.clear()
}, 30_000)

describe("outbox idempotency", () => {
  it("keys rows by draft id so a replayed enqueue cannot double-queue", async () => {
    await enqueueInboundMaterialization("d1", "note", 100)
    await enqueueInboundMaterialization("d1", "note", 200)

    expect(await getDb().inboundMaterializations.count()).toBe(1)
    expect((await getInboundMaterialization("d1"))?.queuedAt).toBe(200)
  })
})

describe("queue drain", () => {
  it("returns queued rows oldest-first and excludes claimed ones", async () => {
    await enqueueInboundMaterialization("late", "note", 900)
    await enqueueInboundMaterialization("early", "lesson", 100)
    await enqueueInboundMaterialization("claimed", "skill", 500)
    // A running row belongs to an in-flight worker; re-picking it would
    // materialize the same draft twice.
    await markMaterializationRunning("claimed")

    expect((await listQueuedMaterializations()).map((r) => r.draftId)).toEqual(["early", "late"])
  })

  it("honours the limit", async () => {
    for (let i = 0; i < 5; i++) await enqueueInboundMaterialization(`d${i}`, "note", i)
    expect(await listQueuedMaterializations(2)).toHaveLength(2)
  })
})

describe("job lifecycle", () => {
  it("counts attempts on each claim", async () => {
    await enqueueInboundMaterialization("d1", "note", 1)
    expect((await getInboundMaterialization("d1"))?.attempts).toBe(0)

    await markMaterializationRunning("d1", 10)
    expect(await getInboundMaterialization("d1")).toMatchObject({
      status: "running",
      startedAt: 10,
      attempts: 1,
    })

    await markMaterializationRunning("d1", 20)
    expect((await getInboundMaterialization("d1"))?.attempts).toBe(2)
  })

  it("claiming a missing row is a no-op rather than a resurrection", async () => {
    await markMaterializationRunning("ghost")
    expect(await getDb().inboundMaterializations.count()).toBe(0)
  })

  it("records the produced row id on completion and clears any prior error", async () => {
    await enqueueInboundMaterialization("d1", "lesson", 1)
    await markMaterializationRunning("d1")
    await markMaterializationFailed("d1", "transient")
    await markMaterializationRunning("d1")
    await markMaterializationCompleted("d1", "mem_123", 99)

    const row = await getInboundMaterialization("d1")
    expect(row).toMatchObject({ status: "completed", producedId: "mem_123", finishedAt: 99 })
    // The earlier failure must be gone, not merely set to undefined — the
    // review UI renders any surviving `error` next to the row.
    expect(row).not.toHaveProperty("error")
  })

  it("truncates a runaway error message", async () => {
    await enqueueInboundMaterialization("d1", "note", 1)
    await markMaterializationFailed("d1", "x".repeat(5000))

    expect((await getInboundMaterialization("d1"))?.error).toHaveLength(2000)
  })

  it("lists failed rows newest-first for the retry UI", async () => {
    await enqueueInboundMaterialization("older", "note", 100)
    await enqueueInboundMaterialization("newer", "note", 900)
    await markMaterializationFailed("older", "e1")
    await markMaterializationFailed("newer", "e2")

    expect((await listFailedMaterializations()).map((r) => r.draftId)).toEqual(["newer", "older"])
  })

  it("retry re-queues while preserving the attempt count", async () => {
    await enqueueInboundMaterialization("d1", "note", 1)
    await markMaterializationRunning("d1")
    await markMaterializationFailed("d1", "boom")

    await retryMaterialization("d1", 500)

    const row = await getInboundMaterialization("d1")
    expect(row).toMatchObject({
      status: "queued",
      queuedAt: 500,
      // The count is the whole point of showing "attempt N" in the UI.
      attempts: 1,
    })
    // A re-queued row carrying the previous run's failure reads as though the
    // retry already failed.
    expect(row).not.toHaveProperty("error")
    expect(row).not.toHaveProperty("finishedAt")
    expect((await listQueuedMaterializations()).map((r) => r.draftId)).toEqual(["d1"])
  })

  it("deletes a row", async () => {
    await enqueueInboundMaterialization("d1", "note", 1)
    await deleteInboundMaterialization("d1")
    expect(await getInboundMaterialization("d1")).toBeUndefined()
  })

  it("completing or retrying a missing row is a no-op, not a resurrection", async () => {
    // A worker whose row was deleted mid-flight must not recreate it — that
    // would put a draft back on the queue after the operator purged it.
    await markMaterializationCompleted("ghost", "mem_1")
    await retryMaterialization("ghost")

    expect(await getDb().inboundMaterializations.count()).toBe(0)
  })

  it("defaults timestamps to now when the caller omits them", async () => {
    const before = Date.now()
    await enqueueInboundMaterialization("d1", "note")
    await markMaterializationRunning("d1")
    await markMaterializationFailed("d1", "boom")

    const row = await getInboundMaterialization("d1")
    expect(row!.queuedAt).toBeGreaterThanOrEqual(before)
    expect(row!.startedAt).toBeGreaterThanOrEqual(before)
    expect(row!.finishedAt).toBeGreaterThanOrEqual(before)
  })
})
