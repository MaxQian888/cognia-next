import "fake-indexeddb/auto"

import { CogniaDB } from "@/lib/db/schema"
import {
  COMPANION_SYNC_TABLES,
  CORE_TABLE_NAMES,
  DATA_TABLE_CATALOG,
  policyForTable,
  tableNamesForCategory,
} from "./table-catalog"

describe("DataTableCatalog", () => {
  it("covers every static CogniaDB table exactly once", () => {
    const db = new CogniaDB("catalog-completeness", "catalog-test")
    const actual = db.tables.map((table) => table.name).sort()
    const catalog = DATA_TABLE_CATALOG.map((entry) => entry.name).sort()

    expect(catalog).toEqual(actual)
    expect(new Set(CORE_TABLE_NAMES).size).toBe(234)
    db.close()
  })

  it("declares complete lifecycle and performance policy for every table", () => {
    for (const entry of DATA_TABLE_CATALOG) {
      expect(entry.owner).not.toBe("")
      expect(entry.backupPolicy.reason).not.toBe("")
      expect(entry.syncPolicy.reason).not.toBe("")
      expect(entry.retentionPolicy.reason).not.toBe("")
      expect(entry.deleteCascade.reason).not.toBe("")
      expect(entry.queryBudget.hotReadMaxMs).toBeGreaterThan(0)
      expect(entry.queryBudget.pageSize).toBeGreaterThan(0)
      if (entry.role !== "authoritative") {
        expect(entry.retentionPolicy.mode).not.toBe("permanent")
      }
    }
  })

  it("fails closed for unknown core tables and applies the plugin default", () => {
    expect(policyForTable("newUngovernedCoreTable")).toBeUndefined()
    expect(policyForTable("example-plugin:rows")).toMatchObject({
      owner: "example-plugin",
      accountScope: "plugin",
      backupPolicy: { mode: "device-local" },
      syncPolicy: { mode: "none" },
      cleanupPolicy: "protected",
    })
  })

  it("maps all 21 companion tables and makes governed other tables discoverable", () => {
    expect(COMPANION_SYNC_TABLES.size).toBe(21)
    expect(tableNamesForCategory("other")).toContain("agentTraces")
    expect(tableNamesForCategory("other")).toContain("workflowRunEvents")
  })

  it("makes RuntimeTarget-owned tables cascade through both isolation levels", () => {
    expect(policyForTable("hostSyncCursors")).toMatchObject({
      accountScope: "runtime-target",
      deleteCascade: { account: true, runtimeTarget: true },
    })
    expect(policyForTable("syncTombstones")).toMatchObject({
      accountScope: "runtime-target",
      deleteCascade: { account: true, runtimeTarget: true },
    })
  })
})
