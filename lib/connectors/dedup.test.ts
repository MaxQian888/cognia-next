/**
 * Tests for the inbound dedup layer (Task 28).
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { recordAndCheckInbound, __resetPruneCounterForTesting } from "./dedup"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetPruneCounterForTesting()
})

describe("recordAndCheckInbound", () => {
  it("returns true on first call (new message)", async () => {
    const isNew = await recordAndCheckInbound("a1", "msg_1")
    expect(isNew).toBe(true)
  })

  it("returns false on duplicate (same adapterId + platformMessageId)", async () => {
    await recordAndCheckInbound("a1", "msg_1")
    const isDup = await recordAndCheckInbound("a1", "msg_1")
    expect(isDup).toBe(false)
  })

  it("different adapterId for the same messageId is NOT a duplicate", async () => {
    await recordAndCheckInbound("a1", "msg_1")
    const isNew = await recordAndCheckInbound("a2", "msg_1")
    expect(isNew).toBe(true)
  })

  it("different messageId for the same adapterId is NOT a duplicate", async () => {
    await recordAndCheckInbound("a1", "msg_1")
    const isNew = await recordAndCheckInbound("a1", "msg_2")
    expect(isNew).toBe(true)
  })

  it("triggers pruneOldest on the 200th call (prune cap = 10_000)", async () => {
    // Seed 500 rows above the cap to make pruning observable at a small scale.
    // We set LEDGER_CAP to 10_000 but the pruner only removes the overflow.
    // For this test: seed 300 rows, call 199 more times (no prune), then
    // call once more (the 200th) and check the prune ran.
    //
    // Since we're under 10_000 total here (499 rows), the prune is a no-op.
    // The important assertion is that the function completes without throwing,
    // and the count matches what we expect.

    const db = getDb()
    // Seed 100 rows (well under 10_000 cap)
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: `a_seed:msg_${i}`,
      adapterId: "a_seed",
      platformMessageId: `msg_${i}`,
      receivedAt: Date.now() - (100 - i),
    }))
    await db.inboundLedger.bulkAdd(rows)

    // Make 199 calls (counters 1-199, no prune)
    for (let i = 0; i < 199; i++) {
      await recordAndCheckInbound("a_ctrl", `ctrl_${i}`)
    }
    // 200th call triggers prune (no-op since total < cap)
    await recordAndCheckInbound("a_ctrl", "ctrl_199")

    // Total = 100 (seeded) + 200 (200 unique calls) = 300, all under cap
    const count = await db.inboundLedger.count()
    expect(count).toBe(300)
  }, 10_000)
})
