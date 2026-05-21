/**
 * Tests for ADR-0020 W1 audit retention sweeper. Uses `fake-indexeddb`
 * so the Dexie store has a real in-memory IDB to talk to.
 */

import "fake-indexeddb/auto"

import { pruneAuditOlderThan } from "./audit-retention"
import { recordAuditRow } from "./audit"
import { __resetDbForTesting, getDb, type AutomationAuditLogRow } from "@/lib/db/schema"

const DAY_MS = 86_400_000

function row(overrides: Partial<AutomationAuditLogRow> = {}): AutomationAuditLogRow {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    surface: "workflow",
    pluginId: null,
    command: "screenshot",
    processName: null,
    windowTitle: null,
    decision: "allow",
    reason: null,
    durationMs: 1,
    error: null,
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("pruneAuditOlderThan", () => {
  it("deletes rows older than the cutoff and reports the count", async () => {
    const now = Date.now()
    await recordAuditRow(row({ ts: now - 40 * DAY_MS, command: "ancient" }))
    await recordAuditRow(row({ ts: now - 31 * DAY_MS, command: "just-over" }))
    await recordAuditRow(row({ ts: now - 15 * DAY_MS, command: "recent" }))
    await recordAuditRow(row({ ts: now, command: "now" }))
    const removed = await pruneAuditOlderThan(30)
    expect(removed).toBe(2)
    const remaining = await getDb().automationAuditLog.toArray()
    expect(remaining.map((r) => r.command).sort()).toEqual(["now", "recent"])
  })

  it("returns 0 for non-positive day windows without touching the table", async () => {
    await recordAuditRow(row({ ts: Date.now() - 365 * DAY_MS }))
    const removedAtZero = await pruneAuditOlderThan(0)
    const removedAtNegative = await pruneAuditOlderThan(-7)
    expect(removedAtZero).toBe(0)
    expect(removedAtNegative).toBe(0)
    const remaining = await getDb().automationAuditLog.count()
    expect(remaining).toBe(1)
  })

  it("returns 0 when nothing has aged out yet", async () => {
    await recordAuditRow(row({ ts: Date.now() }))
    const removed = await pruneAuditOlderThan(30)
    expect(removed).toBe(0)
    expect(await getDb().automationAuditLog.count()).toBe(1)
  })

  it("treats NaN / Infinity as no-op (defensive against a bad settings value)", async () => {
    await recordAuditRow(row({ ts: Date.now() - 365 * DAY_MS }))
    expect(await pruneAuditOlderThan(Number.NaN)).toBe(0)
    expect(await pruneAuditOlderThan(Number.POSITIVE_INFINITY)).toBe(0)
    expect(await getDb().automationAuditLog.count()).toBe(1)
  })
})
