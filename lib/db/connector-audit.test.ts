/**
 * Tests for lib/db/connector-audit.ts — capped audit log for connectors.
 */

import "fake-indexeddb/auto"
import { append, listRecent, __TESTING__ } from "./connector-audit"
import type { AuditEntry } from "@/types/connectors/audit"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeEntry(overrides: Partial<AuditEntry> = {}): Omit<AuditEntry, "id"> {
  return {
    adapterId: overrides.adapterId ?? "adp_1",
    kind: overrides.kind ?? "inbound.received",
    at: overrides.at ?? Date.now(),
    conversationKey: overrides.conversationKey,
    reason: overrides.reason,
    message: overrides.message,
    fields: overrides.fields,
  }
}

describe("connector-audit", () => {
  it("append writes a row and returns it with an id", async () => {
    const entry = makeEntry()
    const row = await append({ id: crypto.randomUUID(), ...entry })
    expect(row.id).toBeDefined()
    expect(row.adapterId).toBe("adp_1")
    expect(row.kind).toBe("inbound.received")
  })

  it("append generates an id if not provided", async () => {
    const row = await append(makeEntry() as AuditEntry)
    expect(row.id).toBeDefined()
    expect(typeof row.id).toBe("string")
  })

  it("listRecent returns rows newest-first", async () => {
    await append({ id: "1", ...makeEntry({ at: 100 }) })
    await append({ id: "2", ...makeEntry({ at: 200 }) })
    await append({ id: "3", ...makeEntry({ at: 300 }) })
    const rows = await listRecent()
    expect(rows.map((r) => r.at)).toEqual([300, 200, 100])
  })

  it("listRecent filters by adapterId", async () => {
    await append({ id: "a1", ...makeEntry({ adapterId: "adp_1", at: 100 }) })
    await append({ id: "b1", ...makeEntry({ adapterId: "adp_2", at: 200 }) })
    await append({ id: "a2", ...makeEntry({ adapterId: "adp_1", at: 300 }) })
    const rows = await listRecent("adp_1")
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.adapterId === "adp_1")).toBe(true)
  })

  it("listRecent respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await append({ id: String(i), ...makeEntry({ at: 1000 + i }) })
    }
    const rows = await listRecent(undefined, 3)
    expect(rows).toHaveLength(3)
  })

  it("cap is 5000", () => {
    expect(__TESTING__.AUDIT_CAP).toBe(5000)
  })

  it("pruneOldest is a no-op when count <= keep", async () => {
    await append({ id: "x", ...makeEntry() })
    const db = getDb()
    await db.transaction("rw", db.connectorAudit, async () => {
      await __TESTING__.pruneOldest(10)
    })
    expect(await getDb().connectorAudit.count()).toBe(1)
  })

  it("pruneOldest trims down to exactly `keep` keeping newest rows", async () => {
    for (let i = 0; i < 10; i++) {
      await append({ id: String(i), ...makeEntry({ at: 1000 + i }) })
    }
    const db = getDb()
    await db.transaction("rw", db.connectorAudit, async () => {
      await __TESTING__.pruneOldest(3)
    })
    const remaining = await listRecent()
    expect(remaining).toHaveLength(3)
    expect(remaining.map((r) => r.at)).toEqual([1009, 1008, 1007])
  })

  it("append enforces cap on overflow (5003 writes → 5000 rows)", async () => {
    for (let i = 0; i < 5003; i++) {
      await append({ id: crypto.randomUUID(), ...makeEntry({ at: i }) })
    }
    expect(await getDb().connectorAudit.count()).toBe(__TESTING__.AUDIT_CAP)
  }, 120_000)
})
