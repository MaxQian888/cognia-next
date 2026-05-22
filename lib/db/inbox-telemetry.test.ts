/**
 * Tests for lib/db/inbox-telemetry.ts — capped breadcrumb log (cap 3000).
 *
 * Mirrors the connector-audit test suite shape since the ring-buffer
 * pattern is identical. The cap is smaller (3000 vs 5000) because telemetry
 * rotates faster than the operator-visible audit log.
 */

import "fake-indexeddb/auto"
import { append, listRecent, __TESTING__ } from "./inbox-telemetry"
import type { InboxTelemetryEventRow, InboxTelemetryKind } from "./inbox-telemetry-types"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeEntry(
  overrides: Partial<InboxTelemetryEventRow> = {}
): Omit<InboxTelemetryEventRow, "id"> {
  return {
    kind: overrides.kind ?? "inbound.received",
    at: overrides.at ?? Date.now(),
    adapterId: overrides.adapterId,
    conversationKey: overrides.conversationKey,
    fields: overrides.fields,
  }
}

describe("inbox-telemetry", () => {
  it("append writes a row with the kind, at, and generated id", async () => {
    const row = await append(makeEntry({ kind: "outbound.sent", at: 100 }))
    expect(row.id).toBeDefined()
    expect(typeof row.id).toBe("string")
    expect(row.kind).toBe("outbound.sent")
    expect(row.at).toBe(100)
  })

  it("append honors a caller-provided id", async () => {
    const row = await append({ id: "fixed-id", ...makeEntry() })
    expect(row.id).toBe("fixed-id")
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
    const rows = await listRecent({ adapterId: "adp_1" })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.adapterId === "adp_1")).toBe(true)
  })

  it("listRecent filters by kind", async () => {
    await append({ id: "1", ...makeEntry({ kind: "inbound.received", at: 100 }) })
    await append({ id: "2", ...makeEntry({ kind: "outbound.sent", at: 200 }) })
    await append({ id: "3", ...makeEntry({ kind: "outbound.sent", at: 300 }) })
    const rows = await listRecent({ kind: "outbound.sent" })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.kind === "outbound.sent")).toBe(true)
  })

  it("listRecent respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await append({ id: String(i), ...makeEntry({ at: 1000 + i }) })
    }
    const rows = await listRecent({ limit: 3 })
    expect(rows).toHaveLength(3)
  })

  it("listRecent combines adapterId + kind + limit filters", async () => {
    await append({ id: "a", ...makeEntry({ adapterId: "x", kind: "outbound.sent", at: 100 }) })
    await append({ id: "b", ...makeEntry({ adapterId: "x", kind: "outbound.failed", at: 200 }) })
    await append({ id: "c", ...makeEntry({ adapterId: "y", kind: "outbound.sent", at: 300 }) })
    await append({ id: "d", ...makeEntry({ adapterId: "x", kind: "outbound.sent", at: 400 }) })
    const rows = await listRecent({ adapterId: "x", kind: "outbound.sent", limit: 5 })
    expect(rows.map((r) => r.id)).toEqual(["d", "a"])
  })

  it("cap constant is 3000", () => {
    expect(__TESTING__.TELEMETRY_CAP).toBe(3000)
  })

  it("pruneOldest is a no-op when count <= keep", async () => {
    await append({ id: "x", ...makeEntry() })
    const db = getDb()
    await db.transaction("rw", db.inboxTelemetryEvents, async () => {
      await __TESTING__.pruneOldest(10)
    })
    expect(await getDb().inboxTelemetryEvents.count()).toBe(1)
  })

  it("pruneOldest trims down to exactly `keep` keeping newest rows", async () => {
    for (let i = 0; i < 10; i++) {
      await append({ id: String(i), ...makeEntry({ at: 1000 + i }) })
    }
    const db = getDb()
    await db.transaction("rw", db.inboxTelemetryEvents, async () => {
      await __TESTING__.pruneOldest(3)
    })
    const remaining = await listRecent()
    expect(remaining).toHaveLength(3)
    expect(remaining.map((r) => r.at)).toEqual([1009, 1008, 1007])
  })

  it("append enforces cap on overflow (3003 writes → 3000 rows)", async () => {
    for (let i = 0; i < 3003; i++) {
      await append({ id: crypto.randomUUID(), ...makeEntry({ at: i }) })
    }
    expect(await getDb().inboxTelemetryEvents.count()).toBe(__TESTING__.TELEMETRY_CAP)
  }, 120_000)

  it("supports every InboxTelemetryKind variant", async () => {
    const kinds: InboxTelemetryKind[] = [
      "inbound.received",
      "outbound.sent",
      "outbound.failed",
      "breaker.open",
      "breaker.close",
      "quiet.deferred",
      "a2ui.downgrade",
    ]
    for (const [idx, kind] of kinds.entries()) {
      await append({ id: `k-${idx}`, ...makeEntry({ kind, at: idx }) })
    }
    const rows = await listRecent()
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(kinds))
  })
})
