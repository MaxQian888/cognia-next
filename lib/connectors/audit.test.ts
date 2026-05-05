/**
 * Tests for the audit append helper (Task 28).
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { appendAudit } from "./audit"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("appendAudit", () => {
  it("writes an audit entry to connectorAudit", async () => {
    await appendAudit({
      adapterId: "a1",
      kind: "inbound.received",
      at: 1_000_000,
      conversationKey: "telegram:a1:42",
    })
    const rows = await getDb().connectorAudit.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].adapterId).toBe("a1")
    expect(rows[0].kind).toBe("inbound.received")
  })

  it("assigns an id when none is provided", async () => {
    await appendAudit({ adapterId: "a1", kind: "adapter.error", at: 1 })
    const rows = await getDb().connectorAudit.toArray()
    expect(rows[0].id).toBeTruthy()
  })

  it("preserves an id when provided", async () => {
    await appendAudit({ id: "fixed-id", adapterId: "a1", kind: "adapter.started", at: 1 })
    const rows = await getDb().connectorAudit.toArray()
    expect(rows[0].id).toBe("fixed-id")
  })
})
