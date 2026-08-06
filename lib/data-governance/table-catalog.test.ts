import "fake-indexeddb/auto"

import { CogniaDB } from "@/lib/db/schema"
import {
  COMPANION_SYNC_TABLES,
  CORE_TABLE_NAMES,
  DATA_TABLE_CATALOG,
  PORTABLE_BACKUP_BINDINGS,
  PORTABLE_BACKUP_TABLES,
  centralRetentionExecutorIds,
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
      if (entry.retentionPolicy.enforcement === "central") {
        expect(entry.retentionPolicy.executorId).not.toBe("")
      }
      if (entry.retentionPolicy.mode === "permanent") {
        expect(entry.retentionPolicy.enforcement).toBe("explicit-delete")
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

  it("binds every portable table to a versioned backup field", () => {
    expect(new Set(Object.keys(PORTABLE_BACKUP_BINDINGS))).toEqual(PORTABLE_BACKUP_TABLES)
    expect(PORTABLE_BACKUP_BINDINGS.contextComments).toBe("contextComments")
    expect(PORTABLE_BACKUP_BINDINGS.providerProfiles).toBe("providerProfileStore")
    expect(policyForTable("tts_provider_keys")?.backupPolicy.mode).not.toBe("portable")
  })

  it("derives central retention executors without duplicate eval targets", () => {
    expect(centralRetentionExecutorIds()).toEqual(["agentTraces", "evalArtifacts"])
    expect(policyForTable("terminalHistory")?.retentionPolicy).toMatchObject({
      mode: "cap",
      maxRows: 5_000,
      enforcement: "domain",
    })
    expect(policyForTable("agentTasks")?.retentionPolicy).toMatchObject({
      mode: "permanent",
      enforcement: "explicit-delete",
    })
  })

  it("fails closed for user history, sync state, and pending work during generic cleanup", () => {
    for (const name of [
      "agentTasks",
      "browserRecordings",
      "conversationOverrides",
      "hostSyncCursors",
      "skillRecordings",
      "syncTombstones",
      "terminalHistory",
    ] as const) {
      expect(policyForTable(name)?.cleanupPolicy).toBe("protected")
    }
    for (const name of [
      "agentTasks",
      "browserRecordings",
      "chatInputHistory",
      "conversationOverrides",
      "evalTasks",
      "skillRecordings",
    ] as const) {
      expect(policyForTable(name)?.role).toBe("authoritative")
      expect(policyForTable(name)?.retentionPolicy.mode).toBe("permanent")
    }
    expect(policyForTable("agentTraces")?.cleanupPolicy).toBe("deep")
    expect(policyForTable("chatSearchState")?.cleanupPolicy).toBe("quick")
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
