import "fake-indexeddb/auto"

import { CogniaDB } from "@/lib/db/schema"
import {
  COMPANION_SYNC_PROTOCOL_TABLE_NAMES,
  COMPANION_SYNC_TABLES,
  CORE_TABLE_NAMES,
  DATA_TABLE_CATALOG,
  PORTABLE_BACKUP_BINDINGS,
  PORTABLE_BACKUP_TABLES,
  centralRetentionExecutorIds,
  policyForTable,
  tableNamesForCategory,
} from "./table-catalog"
import CONTENT_PROTECTION_BASELINE from "./content-protection-baseline.json"

describe("DataTableCatalog", () => {
  /**
   * Whether a table's rows are encrypted at rest must be a DECLARED answer.
   *
   * `contentProtection` is derived, and the last step of that derivation is a
   * substring match over the table name — so a new table holding user content
   * whose name misses the pattern would inherit `metadata-only` and ship in the
   * clear with every other gate green. Pinning the full map is what makes that
   * impossible: a new table fails here until someone writes down what it is,
   * and the classification shows up in the diff as a line a reviewer can see.
   *
   * Adding a table: run the catalog, add the entry to
   * `content-protection-baseline.json`. Changing an existing one from
   * `encrypted-content` to `metadata-only` is a data-exposure change — say why
   * in the commit.
   */
  it("pins the at-rest content protection of every table", () => {
    const actual = Object.fromEntries(
      [...DATA_TABLE_CATALOG]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => [entry.name, entry.contentProtection])
    )

    expect(actual).toEqual(CONTENT_PROTECTION_BASELINE)
  })

  it("covers every static CogniaDB table exactly once", () => {
    const db = new CogniaDB("catalog-completeness", "catalog-test")
    const actual = db.tables.map((table) => table.name).sort()
    const catalog = DATA_TABLE_CATALOG.map((entry) => entry.name).sort()

    expect(catalog).toEqual(actual)
    expect(new Set(CORE_TABLE_NAMES).size).toBe(341)
    db.close()
  })

  it("declares complete lifecycle and performance policy for every table", () => {
    for (const entry of DATA_TABLE_CATALOG) {
      expect(entry.owner).not.toBe("")
      expect(["encrypted-content", "metadata-only", "secret-externalized"]).toContain(
        entry.contentProtection
      )
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

  it("maps all 29 companion tables and makes governed other tables discoverable", () => {
    expect(COMPANION_SYNC_TABLES.size).toBe(29)
    // The unread pointers the mobile Chat badge and Inbox dot count. They used
    // to count `inboundLedger`, which is host-only, so both read 0 on a phone.
    expect(COMPANION_SYNC_TABLES.has("sessionState")).toBe(true)
    // ADR-0131 inbox relay: drafts + outbound status projection are mirrored.
    expect(COMPANION_SYNC_TABLES.has("connectorDrafts")).toBe(true)
    expect(COMPANION_SYNC_TABLES.has("outboundQueue")).toBe(true)
    expect(policyForTable("outboundQueue")?.syncPolicy.mode).not.toBe("none")
    expect(policyForTable("connectorDrafts")?.syncPolicy.mode).not.toBe("none")
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
    // Deduplicated in catalog order: `workInputBatches` and
    // `executionContextBundles` share one executor, and the earlier of the two
    // fixes where it lands in the sequence.
    expect(centralRetentionExecutorIds()).toEqual([
      "agentTraces",
      "evalArtifacts",
      "evalOnline",
      "workSubmissions",
      "memoryGovernance",
      "ocrResults",
      "retrievalControl",
      "workflowAppData",
      "siteArtifacts",
    ])
    expect(policyForTable("ocrResults")?.retentionPolicy).toMatchObject({
      mode: "ttl",
      days: 30,
      enforcement: "central",
      executorId: "ocrResults",
    })
    expect(policyForTable("hostDispatchQueue")?.retentionPolicy).toMatchObject({
      mode: "ttl",
      days: 7,
      enforcement: "domain",
    })
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

  it("keeps the governance ledger device-local, protected, and out of companion sync", () => {
    for (const name of [
      "governanceConflicts",
      "governanceDecisionEvents",
      "governanceDecisions",
      "governanceEvidence",
      "governanceLineage",
      "governanceProvenance",
    ] as const) {
      expect(policyForTable(name)).toMatchObject({
        role: "audit",
        backupPolicy: { mode: "device-local" },
        syncPolicy: { mode: "none" },
        cleanupPolicy: "protected",
      })
      expect(COMPANION_SYNC_TABLES.has(name)).toBe(false)
    }
  })

  it("keeps Matrix encrypted recovery local, bounded, and protected", () => {
    expect(policyForTable("matrixPendingEncryptedEvents")).toMatchObject({
      role: "queue",
      sensitivity: "confidential",
      backupPolicy: { mode: "ephemeral" },
      syncPolicy: { mode: "none" },
      retentionPolicy: { mode: "cap", maxRows: 10_000, enforcement: "domain" },
      cleanupPolicy: "protected",
      expectedScale: "very-large",
    })
    expect(COMPANION_SYNC_TABLES.has("matrixPendingEncryptedEvents")).toBe(false)
  })

  it("governs issue authority, history, runs, and rebuildable GitHub mirrors", () => {
    expect(policyForTable("issues")).toMatchObject({
      role: "authoritative",
      sensitivity: "confidential",
      cleanupPolicy: "protected",
    })
    expect(policyForTable("issueEvents")).toMatchObject({
      role: "audit",
      sensitivity: "confidential",
      expectedScale: "large",
    })
    expect(policyForTable("githubIssueMirror")).toMatchObject({
      role: "cache",
      sensitivity: "confidential",
      backupPolicy: { mode: "derived" },
      cleanupPolicy: "quick",
    })
    // v174 execution bridge: the issue side owns the engine binding, so a run
    // is authoritative user history — device-local, never companion-synced
    // (the engine rows it points at are not synced either), and swept only by
    // the `deleteIssue` cascade.
    expect(policyForTable("issueRuns")).toMatchObject({
      role: "authoritative",
      sensitivity: "confidential",
      backupPolicy: { mode: "device-local" },
      syncPolicy: { mode: "none" },
      retentionPolicy: { mode: "permanent", enforcement: "explicit-delete" },
      cleanupPolicy: "protected",
    })
    expect(COMPANION_SYNC_TABLES.has("issueRuns")).toBe(false)
  })
})

describe("thread-handoff journal", () => {
  it("is device-local, out of companion sync, and honest that nothing deletes it", () => {
    // The sweep retires an expired ticket in place (state -> aborted) rather
    // than removing it, and no delete path exists. A `ttl` or `cap` claim here
    // would describe a sweeper this table does not have.
    expect(policyForTable("threadHandoffTickets")).toMatchObject({
      role: "authoritative",
      backupPolicy: { mode: "device-local" },
      syncPolicy: { mode: "none" },
      retentionPolicy: { mode: "permanent", enforcement: "explicit-delete" },
      cleanupPolicy: "protected",
    })
    expect(policyForTable("threadHandoffTickets").retentionPolicy.reason).toMatch(
      /retired in place/
    )
    expect(COMPANION_SYNC_TABLES.has("threadHandoffTickets")).toBe(false)
  })
})

describe("the sync_pull request contract mirrors this catalogue", () => {
  // `protocol/companion-request-schemas.json` is hand-written and gates the
  // request before it ever reaches the Host, so a name missing from its enum
  // is a 422 for a table the Host serves perfectly well — which is how
  // `plans`, `connectorDrafts` and `outboundQueue` became unpullable while
  // `sync_list_tables` kept advertising all 25.
  it("allows exactly the tables this catalogue declares syncable", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const catalog = JSON.parse(
      readFileSync(join(process.cwd(), "protocol/companion-request-schemas.json"), "utf8")
    ) as {
      commands: Record<string, { properties: { table: { enum: string[] } } }>
    }
    const declared = catalog.commands.sync_pull.properties.table.enum
    expect([...declared].sort()).toEqual([...COMPANION_SYNC_PROTOCOL_TABLE_NAMES].sort())
  })
})
