/** @jest-environment jsdom */
/**
 * Tests for lib/db/inbound-ledger.ts — dedup ledger for inbound messages.
 */

import "fake-indexeddb/auto"
import { recordInbound, isInboundRecorded, pruneOldest } from "./inbound-ledger"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

// The first cold open of the full schema (100+ Dexie versions) can exceed
// jest's default 5 s hook timeout on a loaded machine.
beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

describe("inbound-ledger", () => {
  it("recordInbound returns true on first call for a message", async () => {
    const isNew = await recordInbound("adp_1", "msg_abc")
    expect(isNew).toBe(true)
  })

  it("recordInbound returns false for a duplicate message", async () => {
    await recordInbound("adp_1", "msg_abc")
    const isNew = await recordInbound("adp_1", "msg_abc")
    expect(isNew).toBe(false)
  })

  it("same platformMessageId for different adapters are not duplicates", async () => {
    const first = await recordInbound("adp_1", "msg_shared")
    const second = await recordInbound("adp_2", "msg_shared")
    expect(first).toBe(true)
    expect(second).toBe(true)
  })

  it("persists a row with correct fields including the default inbound namespace", async () => {
    const before = Date.now()
    await recordInbound("adp_1", "msg_xyz")
    const db = getDb()
    const rows = await db.inboundLedger.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].adapterId).toBe("adp_1")
    expect(rows[0].platformMessageId).toBe("msg_xyz")
    expect(rows[0].namespace).toBe("inbound")
    expect(rows[0].receivedAt).toBeGreaterThanOrEqual(before)
    // Primary key includes the namespace so callbacks with identical ids
    // don't collide with messages.
    expect(rows[0].id).toBe("adp_1:inbound:msg_xyz")
  })

  it("namespace=callback dedupes independently from inbound", async () => {
    const firstInbound = await recordInbound("adp_1", "shared_id", "inbound")
    const firstCallback = await recordInbound("adp_1", "shared_id", "callback")
    const secondInbound = await recordInbound("adp_1", "shared_id", "inbound")
    const secondCallback = await recordInbound("adp_1", "shared_id", "callback")
    expect(firstInbound).toBe(true)
    expect(firstCallback).toBe(true)
    expect(secondInbound).toBe(false)
    expect(secondCallback).toBe(false)
    expect(await getDb().inboundLedger.count()).toBe(2)
  })

  it("callback rows are queryable via the compound namespace index", async () => {
    await recordInbound("adp_1", "trigger_123", "callback")
    const found = await getDb()
      .inboundLedger.where("[adapterId+namespace+platformMessageId]")
      .equals(["adp_1", "callback", "trigger_123"])
      .first()
    expect(found).toBeDefined()
    expect(found?.namespace).toBe("callback")
  })

  it("scopes dedup by conversationKey: same messageId in two chats both record", async () => {
    // Telegram message_id / Slack ts are only unique per CHAT — without the
    // conversation scope the second chat's message was permanently dropped.
    const first = await recordInbound("adp_1", "42", "inbound", "telegram:adp_1:chatA")
    const second = await recordInbound("adp_1", "42", "inbound", "telegram:adp_1:chatB")
    expect(first).toBe(true)
    expect(second).toBe(true)
    // A true redelivery in the SAME chat still dedups.
    expect(await recordInbound("adp_1", "42", "inbound", "telegram:adp_1:chatA")).toBe(false)
  })

  it("isInboundRecorded probes without recording", async () => {
    expect(await isInboundRecorded("adp_1", "probe_1", "callback")).toBe(false)
    // The probe must not have consumed the id.
    expect(await recordInbound("adp_1", "probe_1", "callback")).toBe(true)
    expect(await isInboundRecorded("adp_1", "probe_1", "callback")).toBe(true)
    // Scoped probe matches the scoped record.
    await recordInbound("adp_1", "probe_2", "inbound", "telegram:adp_1:chatA")
    expect(await isInboundRecorded("adp_1", "probe_2", "inbound", "telegram:adp_1:chatA")).toBe(
      true
    )
    expect(await isInboundRecorded("adp_1", "probe_2", "inbound", "telegram:adp_1:chatB")).toBe(
      false
    )
  })

  it("maps a lost check-then-add race (ConstraintError) to the duplicate result", async () => {
    // Force the read-side duplicate check to miss so both calls reach `.add`
    // for the same primary key — deterministically reproducing two concurrent
    // deliveries interleaving between check and add.
    const db = getDb()
    const whereSpy = jest.spyOn(db.inboundLedger, "where").mockReturnValue({
      equals: () => ({ first: async () => undefined }),
    } as unknown as ReturnType<typeof db.inboundLedger.where>)
    try {
      const first = await recordInbound("adp_1", "race_1")
      const second = await recordInbound("adp_1", "race_1")
      expect(first).toBe(true)
      // The second .add throws ConstraintError → reported as duplicate, not
      // as a pipeline failure.
      expect(second).toBe(false)
    } finally {
      whereSpy.mockRestore()
    }
  })

  it("pruneOldest is a no-op when count <= cap", async () => {
    await recordInbound("adp_1", "m1")
    await recordInbound("adp_1", "m2")
    await pruneOldest(10)
    const count = await getDb().inboundLedger.count()
    expect(count).toBe(2)
  })

  it("pruneOldest keeps exactly `cap` newest rows", async () => {
    // Insert 10 rows with deterministic receivedAt ordering
    for (let i = 0; i < 10; i++) {
      await recordInbound("adp_1", `msg_${i}`)
      // Force distinct receivedAt via waiting
      await new Promise((r) => setTimeout(r, 1))
    }
    await pruneOldest(3)
    const db = getDb()
    const remaining = await db.inboundLedger.orderBy("receivedAt").toArray()
    expect(remaining).toHaveLength(3)
    // The 3 newest survive (msg_7, msg_8, msg_9)
    expect(remaining.map((r) => r.platformMessageId)).toEqual(["msg_7", "msg_8", "msg_9"])
  })

  it("pruneOldest default cap is 10_000", async () => {
    // Just verify it runs without error (functional test on small data)
    for (let i = 0; i < 5; i++) {
      await recordInbound("adp_1", `m${i}`)
    }
    await pruneOldest()
    expect(await getDb().inboundLedger.count()).toBe(5)
  })
})
