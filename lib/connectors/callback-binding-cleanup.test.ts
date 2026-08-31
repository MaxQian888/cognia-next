/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { LEGACY_GRACE_MS, cleanupExpiredCallbackBindings } from "./callback-binding-cleanup"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"

const NOW = 1_750_000_000_000

async function seed(rows: ConnectorCallbackBindingRow[]): Promise<void> {
  await getDb().connectorCallbackBindings.bulkPut(rows)
}

function makeRow(
  id: string,
  overrides: Partial<ConnectorCallbackBindingRow> = {}
): ConnectorCallbackBindingRow {
  return {
    id,
    adapterId: "tg-1",
    actionId: id,
    kind: "callback_query",
    surfaceId: "s1",
    componentId: "btn1",
    conversationKey: "tg:c1",
    createdAt: NOW - 1000,
    expiresAt: undefined,
    ...overrides,
  }
}

beforeEach(async () => {
  try {
    await getDb().delete()
  } catch {
    // Initial run before a DB exists — `delete()` may throw; safe to ignore.
  }
  __resetDbForTesting()
  getDb()
})

describe("cleanupExpiredCallbackBindings", () => {
  it("deletes rows whose expiresAt has passed", async () => {
    await seed([
      makeRow("a", { expiresAt: NOW - 1 }),
      makeRow("b", { expiresAt: NOW + 1000 }),
      makeRow("c", { expiresAt: NOW - 5_000 }),
    ])

    const result = await cleanupExpiredCallbackBindings({ now: NOW })

    expect(result.expiredCount).toBe(2)
    expect(result.legacyCount).toBe(0)
    expect(result.total).toBe(2)
    const remaining = await getDb().connectorCallbackBindings.toArray()
    expect(remaining.map((r) => r.id).sort()).toEqual(["b"])
  })

  it("keeps rows with expiresAt strictly in the future", async () => {
    await seed([makeRow("future", { expiresAt: NOW + 60_000 })])
    const result = await cleanupExpiredCallbackBindings({ now: NOW })
    expect(result.total).toBe(0)
    expect(await getDb().connectorCallbackBindings.count()).toBe(1)
  })

  it("reaps legacy rows older than the grace window", async () => {
    const legacyOld = makeRow("legacy-old", {
      expiresAt: undefined,
      createdAt: NOW - LEGACY_GRACE_MS - 1,
    })
    const legacyYoung = makeRow("legacy-young", {
      expiresAt: undefined,
      createdAt: NOW - 1000,
    })
    await seed([legacyOld, legacyYoung])

    const result = await cleanupExpiredCallbackBindings({ now: NOW })

    expect(result.expiredCount).toBe(0)
    expect(result.legacyCount).toBe(1)
    expect(result.total).toBe(1)
    const remaining = await getDb().connectorCallbackBindings.toArray()
    expect(remaining.map((r) => r.id)).toEqual(["legacy-young"])
  })

  it("honours a custom legacyGraceMs override", async () => {
    await seed([makeRow("legacy", { expiresAt: undefined, createdAt: NOW - 5000 })])

    const tightResult = await cleanupExpiredCallbackBindings({ now: NOW, legacyGraceMs: 1000 })
    expect(tightResult.legacyCount).toBe(1)
    expect(await getDb().connectorCallbackBindings.count()).toBe(0)
  })

  it("returns zero counts when the table is empty", async () => {
    const result = await cleanupExpiredCallbackBindings({ now: NOW })
    expect(result).toEqual({ expiredCount: 0, legacyCount: 0, total: 0 })
  })

  it("returns zero counts when nothing has expired", async () => {
    await seed([
      makeRow("a", { expiresAt: NOW + 60_000 }),
      makeRow("b", { expiresAt: NOW + 90_000 }),
    ])
    const result = await cleanupExpiredCallbackBindings({ now: NOW })
    expect(result).toEqual({ expiredCount: 0, legacyCount: 0, total: 0 })
    expect(await getDb().connectorCallbackBindings.count()).toBe(2)
  })
})
