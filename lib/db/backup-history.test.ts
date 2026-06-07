// Coverage for the backupHistory CRUD module — append, listing/filter, latest,
// pruning, and clear/delete. Uses fake-indexeddb so we exercise the real Dexie
// query path against an in-memory IDB.

import "fake-indexeddb/auto"
import {
  appendBackupHistory,
  clearBackupHistory,
  deleteBackupHistory,
  getLatestSuccessful,
  listBackupHistory,
  __TESTING__,
} from "./backup-history"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  // Touch getDb() and wait for the seed so we don't race in each test. We
  // don't actually use the seeded characters/skills here.
  getDb()
  await whenSeeded()
})

describe("appendBackupHistory", () => {
  it("inserts a row, fills schemaVersion, and returns it", async () => {
    const row = await appendBackupHistory({
      completedAt: 100,
      type: "manual",
      success: true,
      encryption: "none",
      filename: "f.cbk",
    })
    expect(row.id).toMatch(/^bh_/)
    expect(row.schemaVersion).toBe(3)
    const fetched = await getDb().backupHistory.get(row.id)
    expect(fetched?.filename).toBe("f.cbk")
  })

  it("respects an explicit id when provided", async () => {
    const row = await appendBackupHistory({
      id: "explicit-1",
      completedAt: 1,
      type: "manual",
      success: false,
      encryption: "none",
      errorMessage: "boom",
    })
    expect(row.id).toBe("explicit-1")
    expect(row.errorMessage).toBe("boom")
  })

  it("prunes oldest rows beyond the cap", async () => {
    const cap = __TESTING__.HISTORY_CAP
    for (let i = 0; i < cap + 10; i++) {
      await appendBackupHistory({
        completedAt: i + 1,
        type: "manual",
        success: true,
        encryption: "none",
      })
    }
    const total = await getDb().backupHistory.count()
    expect(total).toBe(cap)
    // Oldest 10 should be gone.
    const remaining = await getDb().backupHistory.orderBy("completedAt").toArray()
    expect(remaining[0].completedAt).toBeGreaterThan(10)
  })
})

describe("listBackupHistory", () => {
  beforeEach(async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
    })
    await appendBackupHistory({
      completedAt: 2,
      type: "scheduled",
      success: false,
      encryption: "auto-key",
      errorMessage: "no disk",
    })
    await appendBackupHistory({
      completedAt: 3,
      type: "scheduled",
      success: true,
      encryption: "auto-key",
    })
  })

  it("orders newest-first by default", async () => {
    const rows = await listBackupHistory()
    expect(rows.map((r) => r.completedAt)).toEqual([3, 2, 1])
  })

  it("filters by type", async () => {
    const rows = await listBackupHistory({ type: "scheduled" })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.type === "scheduled")).toBe(true)
  })

  it("filters to successful rows", async () => {
    const rows = await listBackupHistory({ successOnly: true })
    expect(rows.every((r) => r.success === true)).toBe(true)
  })

  it("respects the limit", async () => {
    const rows = await listBackupHistory({ limit: 2 })
    expect(rows).toHaveLength(2)
  })

  it("ignores a non-positive limit", async () => {
    const rows = await listBackupHistory({ limit: 0 })
    expect(rows.length).toBeGreaterThanOrEqual(3)
  })
})

describe("getLatestSuccessful", () => {
  it("returns the newest success row, ignoring failures", async () => {
    await appendBackupHistory({
      completedAt: 5,
      type: "manual",
      success: false,
      encryption: "none",
    })
    await appendBackupHistory({
      completedAt: 4,
      type: "manual",
      success: true,
      encryption: "none",
      filename: "older.cbk",
    })
    await appendBackupHistory({
      completedAt: 6,
      type: "manual",
      success: true,
      encryption: "none",
      filename: "newer.cbk",
    })
    const latest = await getLatestSuccessful()
    expect(latest?.filename).toBe("newer.cbk")
  })

  it("returns undefined when no success exists", async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: false,
      encryption: "none",
    })
    expect(await getLatestSuccessful()).toBeUndefined()
  })
})

describe("payloadKind (subscription vs data rows)", () => {
  beforeEach(async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "passphrase",
      // No payloadKind — legacy data row.
    })
    await appendBackupHistory({
      completedAt: 2,
      type: "auto",
      success: true,
      encryption: "passphrase",
      payloadKind: "subscription",
      filename: "cognia-subscription-x.cogniabak.json",
    })
    await appendBackupHistory({
      completedAt: 3,
      type: "auto",
      success: true,
      encryption: "passphrase",
      payloadKind: "data",
    })
  })

  it("filters by payloadKind, counting legacy rows as data", async () => {
    const data = await listBackupHistory({ payloadKind: "data" })
    expect(data.map((r) => r.completedAt)).toEqual([3, 1])
    const subs = await listBackupHistory({ payloadKind: "subscription" })
    expect(subs.map((r) => r.completedAt)).toEqual([2])
  })

  it("getLatestSuccessful defaults to the data pipeline", async () => {
    // The newest row overall is the data row at t=3; the subscription row at
    // t=2 must NOT leak into the data dirty check.
    const latest = await getLatestSuccessful()
    expect(latest?.completedAt).toBe(3)
    const latestSub = await getLatestSuccessful("subscription")
    expect(latestSub?.completedAt).toBe(2)
  })
})

describe("clearBackupHistory / deleteBackupHistory", () => {
  it("clear removes everything", async () => {
    await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
    })
    await clearBackupHistory()
    expect(await getDb().backupHistory.count()).toBe(0)
  })

  it("delete removes a single row by id", async () => {
    const row = await appendBackupHistory({
      completedAt: 1,
      type: "manual",
      success: true,
      encryption: "none",
    })
    await deleteBackupHistory(row.id)
    expect(await getDb().backupHistory.get(row.id)).toBeUndefined()
  })
})
