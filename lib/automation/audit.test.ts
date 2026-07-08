/** @jest-environment jsdom */
/**
 * Tests for the automation audit Dexie mirror. Uses `fake-indexeddb` for
 * an in-memory IDB shim — required because Jest's jsdom environment doesn't
 * ship a real `indexedDB`.
 */

import "fake-indexeddb/auto"

import { AUTOMATION_AUDIT_CAP, clearAuditLog, listAuditRows, recordAuditRow } from "./audit"
import { __resetDbForTesting, getDb, type AutomationAuditLogRow } from "@/lib/db/schema"

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
  // Drop the in-memory IDB so this test starts fresh — necessary because
  // `fake-indexeddb/auto` keeps a process-wide IDBFactory that survives
  // across test files in the same Jest worker, so prior runs can leak
  // rows into our table.
  await getDb().delete()
  __resetDbForTesting()
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("recordAuditRow", () => {
  it("appends a single row", async () => {
    await recordAuditRow(row({ command: "click" }))
    const rows = await listAuditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].command).toBe("click")
  })

  // Inserting 5003 rows through fake-indexeddb (each in its own transaction
  // that does put + count + possibly bulkDelete) is genuinely slow — bump
  // the per-test timeout so the cap enforcement test has room to finish.
  it("enforces the 5000-newest cap by evicting oldest rows", async () => {
    // Insert AUTOMATION_AUDIT_CAP + 3 rows with strictly-increasing ts.
    for (let i = 0; i < AUTOMATION_AUDIT_CAP + 3; i++) {
      await recordAuditRow(row({ ts: 1_000_000 + i }))
    }
    const all = await listAuditRows({ limit: AUTOMATION_AUDIT_CAP + 10 })
    expect(all.length).toBe(AUTOMATION_AUDIT_CAP)
    // Newest first: first row's ts should be the latest we inserted.
    expect(all[0].ts).toBe(1_000_000 + AUTOMATION_AUDIT_CAP + 2)
    // Oldest 3 should have been evicted.
    const oldest = all[all.length - 1]
    expect(oldest.ts).toBe(1_000_000 + 3)
  }, 30_000)
})

describe("listAuditRows filters", () => {
  it("filters by surface", async () => {
    await recordAuditRow(row({ surface: "workflow" }))
    await recordAuditRow(row({ surface: "mcp" }))
    await recordAuditRow(row({ surface: "plugin" }))
    const mcp = await listAuditRows({ surface: "mcp" })
    expect(mcp).toHaveLength(1)
    expect(mcp[0].surface).toBe("mcp")
  })

  it("filters by decision", async () => {
    await recordAuditRow(row({ decision: "allow" }))
    await recordAuditRow(row({ decision: "deny" }))
    await recordAuditRow(row({ decision: "consent" }))
    const denied = await listAuditRows({ decision: "deny" })
    expect(denied).toHaveLength(1)
    expect(denied[0].decision).toBe("deny")
  })

  it("respects the limit", async () => {
    for (let i = 0; i < 10; i++) {
      await recordAuditRow(row({ ts: 1000 + i }))
    }
    const five = await listAuditRows({ limit: 5 })
    expect(five).toHaveLength(5)
  })
})

describe("clearAuditLog", () => {
  it("removes every row", async () => {
    await recordAuditRow(row())
    await recordAuditRow(row())
    expect((await listAuditRows()).length).toBe(2)
    await clearAuditLog()
    expect((await listAuditRows()).length).toBe(0)
  })
})
