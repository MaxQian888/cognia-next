/**
 * Tests for lib/db/notification-aggregates.ts — the durable digest-member
 * ledger. Covers the idempotent join (crash-replay never double-counts), the
 * unflushed/bucket-bounded read, the flush mark, and the per-fact lookup.
 */

import { createDbTestFixture } from "./test-fixture"
import {
  addAggregateMember,
  listUnflushedMembers,
  markMembersFlushed,
  listMembersForNotification,
} from "./notification-aggregates"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const SCOPE = "scope-A"

function member(over: Partial<Parameters<typeof addAggregateMember>[0]> = {}) {
  return {
    scopeKey: SCOPE,
    aggregateKey: over.aggregateKey ?? "agg-1",
    notificationId: over.notificationId ?? "n1",
    bucketOpenedAt: over.bucketOpenedAt ?? 100,
    ...(over.joinedAt !== undefined ? { joinedAt: over.joinedAt } : {}),
    ...(over.logicalKey ? { logicalKey: over.logicalKey } : {}),
  }
}

describe("addAggregateMember", () => {
  it("folds a fact into the bucket", async () => {
    const row = await addAggregateMember(member({ notificationId: "n1" }))
    expect(row.aggregateKey).toBe("agg-1")
    expect(row.notificationId).toBe("n1")
    expect(row.bucketOpenedAt).toBe(100)
    expect(row.flushedAt).toBeUndefined()
  })

  it("is idempotent — re-adding the same fact to the same open bucket is a no-op", async () => {
    const a = await addAggregateMember(member({ notificationId: "n1" }))
    const b = await addAggregateMember(member({ notificationId: "n1" }))
    expect(b.id).toBe(a.id) // crash-replay never double-counts
    expect(await listUnflushedMembers("agg-1")).toHaveLength(1)
  })

  it("the SAME fact under a NEW bucket window joins the next bucket", async () => {
    const a = await addAggregateMember(member({ notificationId: "n1", bucketOpenedAt: 100 }))
    const b = await addAggregateMember(member({ notificationId: "n1", bucketOpenedAt: 200 }))
    expect(b.id).not.toBe(a.id)
  })
})

describe("listUnflushedMembers", () => {
  it("returns only unflushed members of the bucket", async () => {
    const a = await addAggregateMember(member({ notificationId: "n1" }))
    await addAggregateMember(member({ notificationId: "n2" }))
    await markMembersFlushed([a.id], 500)
    const unflushed = await listUnflushedMembers("agg-1")
    expect(unflushed.map((m) => m.notificationId)).toEqual(["n2"])
  })

  it("bounds the read to a specific bucket window", async () => {
    await addAggregateMember(member({ notificationId: "n1", bucketOpenedAt: 100 }))
    await addAggregateMember(member({ notificationId: "n2", bucketOpenedAt: 200 }))
    const w100 = await listUnflushedMembers("agg-1", 100)
    expect(w100.map((m) => m.notificationId)).toEqual(["n1"])
    const w200 = await listUnflushedMembers("agg-1", 200)
    expect(w200.map((m) => m.notificationId)).toEqual(["n2"])
  })
})

describe("markMembersFlushed", () => {
  it("marks the given members flushed at the given time", async () => {
    const a = await addAggregateMember(member({ notificationId: "n1" }))
    const b = await addAggregateMember(member({ notificationId: "n2" }))
    await markMembersFlushed([a.id, b.id], 600)
    expect(await listUnflushedMembers("agg-1")).toHaveLength(0)
  })

  it("is idempotent — re-flushing an already-flushed member is a no-op", async () => {
    const a = await addAggregateMember(member({ notificationId: "n1" }))
    await markMembersFlushed([a.id], 600)
    await markMembersFlushed([a.id], 700) // must NOT move flushedAt
    const { getDb } = await import("./schema")
    const stored = await getDb().notificationAggregateMembers.get(a.id)
    expect(stored?.flushedAt).toBe(600)
  })
})

describe("listMembersForNotification", () => {
  it("returns every bucket a fact was digested into", async () => {
    await addAggregateMember(member({ notificationId: "n1", aggregateKey: "agg-a" }))
    await addAggregateMember(member({ notificationId: "n1", aggregateKey: "agg-b" }))
    await addAggregateMember(member({ notificationId: "other", aggregateKey: "agg-a" }))
    const rows = await listMembersForNotification("n1")
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.aggregateKey).sort()).toEqual(["agg-a", "agg-b"])
  })
})
