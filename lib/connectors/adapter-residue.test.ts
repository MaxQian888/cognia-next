/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { conversationKeyPrefix, reapAdapterResidue } from "./adapter-residue"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

const KEEP = "other-adapter"
const TARGET = { id: "tg-1", type: "telegram" }

/** Seed one row per table the reaper touches, for the target AND a bystander. */
async function seed(): Promise<void> {
  const db = getDb()
  await db.connectorAudit.bulkPut([
    { id: "a1", adapterId: TARGET.id, kind: "inbound.received", at: 1 },
    { id: "a2", adapterId: KEEP, kind: "inbound.received", at: 1 },
  ] as never)
  await db.inboundLedger.bulkPut([
    { id: "l1", adapterId: TARGET.id, platformMessageId: "m1", receivedAt: 1 },
    { id: "l2", adapterId: KEEP, platformMessageId: "m1", receivedAt: 1 },
  ] as never)
  await db.connectorInboundJobs.bulkPut([
    {
      id: "j1",
      adapterId: TARGET.id,
      platformMessageId: "m1",
      sourceMessageId: "m1",
      conversationKey: `telegram:${TARGET.id}:42`,
      event: {},
      dispatchMode: "fifo",
      status: "completed",
      attempts: 1,
      receivedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "j2",
      adapterId: KEEP,
      platformMessageId: "m2",
      sourceMessageId: "m2",
      conversationKey: `telegram:${KEEP}:42`,
      event: {},
      dispatchMode: "fifo",
      status: "completed",
      attempts: 1,
      receivedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ] as never)
  await db.outboundQueue.bulkPut([
    {
      id: "o1",
      adapterId: TARGET.id,
      conversationKey: `telegram:${TARGET.id}:42`,
      status: "pending",
      createdAt: 1,
      orderSeq: 1,
    },
    {
      id: "o2",
      adapterId: KEEP,
      conversationKey: `telegram:${KEEP}:42`,
      status: "pending",
      createdAt: 1,
      orderSeq: 1,
    },
  ] as never)
  await db.platformIdentities.bulkPut([
    {
      id: "p1",
      platform: "telegram",
      adapterId: TARGET.id,
      remoteUserId: "7",
      lastSeenAt: 1,
    },
    { id: "p2", platform: "telegram", adapterId: KEEP, remoteUserId: "7", lastSeenAt: 1 },
  ] as never)
  await db.conversationOverrides.bulkPut([
    { id: "c1", conversationKey: `telegram:${TARGET.id}:42`, updatedAt: 1 },
    { id: "c2", conversationKey: `telegram:${KEEP}:42`, updatedAt: 1 },
  ] as never)
  await db.connectorCleanupJobs.bulkPut([
    {
      id: "k1",
      adapterId: TARGET.id,
      reason: "adapter_removed",
      cacheKey: "deadbeef",
      attempts: 0,
      nextAttemptAt: 1,
      createdAt: 1,
    },
  ] as never)
}

describe("conversationKeyPrefix", () => {
  it("uses the same separator conversation keys are built with", () => {
    expect(conversationKeyPrefix(TARGET)).toBe("telegram:tg-1:")
  })

  it("is undefined without a platform kind", () => {
    expect(conversationKeyPrefix({ id: "tg-1" })).toBeUndefined()
  })
})

describe("reapAdapterResidue", () => {
  it("removes the target's rows from every adapter-keyed table", async () => {
    await seed()
    const report = await reapAdapterResidue(TARGET)

    const db = getDb()
    expect(await db.connectorAudit.where("adapterId").equals(TARGET.id).count()).toBe(0)
    expect(await db.inboundLedger.where("adapterId").equals(TARGET.id).count()).toBe(0)
    expect(await db.connectorInboundJobs.where("adapterId").equals(TARGET.id).count()).toBe(0)
    expect(report.reaped["connectorAudit"]).toBe(1)
  })

  it("leaves every other adapter's rows alone", async () => {
    await seed()
    await reapAdapterResidue(TARGET)

    const db = getDb()
    expect(await db.connectorAudit.where("adapterId").equals(KEEP).count()).toBe(1)
    expect(await db.inboundLedger.where("adapterId").equals(KEEP).count()).toBe(1)
    expect(await db.connectorInboundJobs.where("adapterId").equals(KEEP).count()).toBe(1)
    expect(
      await db.outboundQueue.where("[adapterId+status]").equals([KEEP, "pending"]).count()
    ).toBe(1)
    expect(await db.conversationOverrides.get("c2")).toBeDefined()
  })

  it("reaps the compound-indexed tables over the whole adapter", async () => {
    await seed()
    await reapAdapterResidue(TARGET)

    const db = getDb()
    expect(await db.outboundQueue.get("o1")).toBeUndefined()
    expect(await db.platformIdentities.get("p1")).toBeUndefined()
    expect(await db.platformIdentities.get("p2")).toBeDefined()
  })

  it("reaps per-conversation policy for this adapter's conversations only", async () => {
    await seed()
    await reapAdapterResidue(TARGET)

    const db = getDb()
    expect(await db.conversationOverrides.get("c1")).toBeUndefined()
    expect(await db.conversationOverrides.get("c2")).toBeDefined()
  })

  it("KEEPS the attachment cleanup ledger — those retries must outlive the bot", async () => {
    // Reaping them would strand the encrypted blob on disk with nothing left
    // that knows which key it belongs to.
    await seed()
    await reapAdapterResidue(TARGET)

    expect(await getDb().connectorCleanupJobs.get("k1")).toBeDefined()
  })

  it("reports conversation tables as unreachable when the platform kind is unknown", async () => {
    await seed()
    const report = await reapAdapterResidue({ id: TARGET.id })

    // "Could not look" must be distinguishable from "nothing to reap".
    expect(report.failed).toContain("conversationOverrides")
    expect(await getDb().conversationOverrides.get("c1")).toBeDefined()
    // The adapter-keyed tables still went.
    expect(await getDb().connectorAudit.where("adapterId").equals(TARGET.id).count()).toBe(0)
  })

  it("omits tables that had nothing to delete", async () => {
    const report = await reapAdapterResidue(TARGET)
    expect(report.reaped).toEqual({})
  })

  it("never throws, and names a table it could not reap", async () => {
    const db = getDb() as unknown as Record<string, unknown>
    const original = db["connectorAudit"]
    db["connectorAudit"] = {
      where: () => ({
        equals: () => ({
          delete: () => Promise.reject(new Error("boom")),
        }),
      }),
    }
    try {
      const report = await reapAdapterResidue(TARGET)
      expect(report.failed).toContain("connectorAudit")
    } finally {
      db["connectorAudit"] = original
    }
  })
})
