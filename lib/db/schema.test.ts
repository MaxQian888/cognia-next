/** @jest-environment jsdom */
// Coverage for the schema module — Dexie instance lifecycle, lazy seeding,
// and the test reset helper. Also exercises the v5 (members[]) and v7
// (appsEnabled={}) upgrade hooks indirectly: the seeder runs against a
// freshly opened DB, which means the latest schema version opens cleanly.

import "fake-indexeddb/auto"

import Dexie from "dexie"

import {
  CogniaDB,
  LEGACY_COGNIA_DB_NAME,
  __resetDbForTesting,
  activateAccountDatabase,
  backfillMemoryGovernanceV164,
  backfillMemoryJobV164,
  backfillMemoryGovernanceV118,
  backfillRootsForRow,
  clearAccountDatabaseSelection,
  getDb,
  getOpenDatabaseConnectionOwners,
  getDatabaseUpgradeBlockerOwners,
  startBlockedYieldRetry,
  whenSeeded,
  withDbReopenRetry,
} from "./schema"
import type { OutboundJobRow } from "./connector-types"
import { emit, listen } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/platform/detect"

// The cross-window yield handshake lazily imports the Tauri event API and gates
// on isTauri(); stub both so the Tauri path is exercisable under jsdom. isTauri
// defaults to the real (false) detection so every non-Tauri suite is unchanged.
jest.mock("@tauri-apps/api/event", () => ({
  __esModule: true,
  emit: jest.fn(() => Promise.resolve()),
  listen: jest.fn(() => Promise.resolve(() => {})),
}))
jest.mock("@/lib/platform/detect", () => {
  const actual = jest.requireActual("@/lib/platform/detect")
  return { __esModule: true, ...actual, isTauri: jest.fn(actual.isTauri) }
})

/**
 * These tests each seed a legacy-versioned database and reopen it as a
 * `CogniaDB`, so they pay a real fake-indexeddb open plus an upgrade. 30s
 * covers that under a loaded parallel run; the default 5s does not.
 *
 * They assert the CURRENT schema: that the store and its indexes exist, and
 * that rows written before the upgrade survive it. They deliberately do NOT
 * assert data transformation — `lib/db/schema.ts` declares one cumulative
 * version and runs no `upgrade()` hooks, so a test asserting a backfill would
 * be testing nothing.
 */
function schemaIt(name: string, run: () => Promise<void>, timeout = 30_000): void {
  it(name, run, timeout)
}

/** Minimal valid `outboundQueue` row for index-behaviour tests. */
function makeOutboundRow(
  id: string,
  over: Partial<OutboundJobRow> & Pick<OutboundJobRow, "status" | "nextAttemptAt">
): OutboundJobRow {
  return {
    id,
    adapterId: "tg-v51",
    conversationKey: "telegram:tg-v51:1",
    request: {
      conversationRef: { platform: "telegram", adapterId: "tg-v51" },
      segments: [{ type: "text", text: "hi" }],
      metadata: { idempotencyKey: id },
    },
    attempts: 0,
    createdAt: Date.now(),
    idempotencyKey: id,
    source: "ai-run",
    ...over,
  }
}

describe("getDb", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  schemaIt("v203 adds the Sites build-log table", async () => {
    const name = `cognia-site-build-logs-v203-${Date.now()}`
    const legacy = new Dexie(name)
    legacy.version(202).stores({ sessions: "id, updatedAt" })
    await legacy.open()
    await legacy.table("sessions").put({ id: "session-before-build-logs", updatedAt: 1 })
    legacy.close()

    const upgraded = new CogniaDB(name)
    await upgraded.open()
    expect(upgraded.verno).toBeGreaterThanOrEqual(203)
    expect(upgraded.siteBuildLogs.schema.primKey.keyPath).toBe("id")
    // `[versionId+phase]` reads one phase directly rather than filtering a
    // version's rows in memory.
    expect(upgraded.siteBuildLogs.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["versionId", "siteId", "operationId", "[versionId+phase]"])
    )
    expect(await upgraded.sessions.get("session-before-build-logs")).toEqual({
      id: "session-before-build-logs",
      updatedAt: 1,
    })
    upgraded.close()
  })

  schemaIt("v210 indexes project-claim and evidence lookup without touching data", async () => {
    const name = `cognia-project-context-v210-${Date.now()}`
    const legacy = new Dexie(name)
    legacy.version(209).stores({
      sessions: "id, updatedAt",
      memories: "&id, scope, type, status",
      memoryEvidence: "&id, memoryId, kind, sessionId, createdAt",
    })
    await legacy.open()
    await legacy.table("memories").put({
      id: "legacy-mem",
      scope: "global",
      type: "semantic",
      text: "Prefers pnpm",
      tags: [],
      importance: 5,
      createdAt: 1,
      updatedAt: 1,
      lastAccessedAt: 1,
      accessCount: 0,
      version: 1,
      status: "active",
      pinned: false,
      provenance: "user",
    })
    await legacy.table("memoryEvidence").put({
      id: "legacy-ev",
      memoryId: "legacy-mem",
      kind: "message",
      sourceId: "s1:turn:2",
      sessionId: "s1",
      messageId: "m2",
      contaminationState: "clean",
      reviewed: false,
      createdAt: 1,
    })
    legacy.close()

    const upgraded = new CogniaDB(name)
    await upgraded.open()
    expect(upgraded.verno).toBeGreaterThanOrEqual(210)

    // `messageId` is the load-bearing addition: deleting a message has to be able
    // to ask "which learned rows rest on this?" before the claims citing it keep
    // being injected. `[sessionId+messageId]` answers it for a whole session.
    expect(upgraded.memoryEvidence.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["messageId", "validationState", "[sessionId+messageId]"])
    )
    expect(upgraded.memories.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["projectMemoryKind", "trustState", "[projectId+projectMemoryKind]"])
    )

    // The migration is purely additive. Backfilling any of these would change
    // behavior for existing users: a fabricated `projectMemoryKind` would move a
    // personal row into the project corpus, `observedAt = createdAt` is the exact
    // lie that field exists to prevent, and `trustState: "trusted"` would raise
    // every legacy row's governance score and re-rank retrieval.
    const memory = await upgraded.memories.get("legacy-mem")
    expect(memory).toMatchObject({ id: "legacy-mem", text: "Prefers pnpm" })
    expect(memory?.projectMemoryKind).toBeUndefined()
    expect(memory?.observedAt).toBeUndefined()
    expect(memory?.validatedAt).toBeUndefined()
    expect(memory?.trustState).toBeUndefined()

    const evidence = await upgraded.memoryEvidence.get("legacy-ev")
    expect(evidence).toMatchObject({ id: "legacy-ev", messageId: "m2" })
    expect(evidence?.validationState).toBeUndefined()
    expect(evidence?.validationStrategy).toBeUndefined()

    upgraded.close()
    await Dexie.delete(name)
  })

  schemaIt("v211 adds the online-evaluation tables without touching data", async () => {
    const name = `cognia-online-eval-v211-${Date.now()}`
    const legacy = new Dexie(name)
    legacy.version(210).stores({
      sessions: "id, updatedAt",
      evalScores: "&id, experimentId, sampleId, scorerId, createdAt",
    })
    await legacy.open()
    // A pre-envelope score row: no scope, no origin. It is read as `offline`,
    // never rewritten — a migration that invents provenance produces records
    // indistinguishable from real ones.
    await legacy.table("evalScores").put({
      id: "legacy-score",
      experimentId: "exp-1",
      sampleId: "sample-1",
      scorerId: "tool-selection",
      createdAt: 1,
    })
    legacy.close()

    const upgraded = new CogniaDB(name)
    await upgraded.open()
    expect(upgraded.verno).toBeGreaterThanOrEqual(211)

    // `dedupeKey` is unique on purpose: it is the idempotency key that stops a
    // re-offered trace being scored — and charged — twice.
    expect(upgraded.evalOnlineQueue.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["dedupeKey", "state", "[state+enqueuedAt]", "[policyId+state]"])
    )
    expect(
      upgraded.evalOnlineQueue.schema.indexes.find((index) => index.name === "dedupeKey")?.unique
    ).toBe(true)
    expect(upgraded.evalObservations.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["origin", "scope.traceId", "[origin+createdAt]"])
    )
    expect(upgraded.evalOnlinePolicies.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["workspaceId", "[workspaceId+enabledFlag]"])
    )

    // Purely additive: the legacy score row is untouched and the new tables
    // start empty rather than being seeded from it.
    expect(await upgraded.table("evalScores").get("legacy-score")).toMatchObject({
      id: "legacy-score",
      scorerId: "tool-selection",
    })
    expect(await upgraded.evalObservations.count()).toBe(0)
    expect(await upgraded.evalOnlineBudget.count()).toBe(0)

    upgraded.close()
    await Dexie.delete(name)
  })

  schemaIt("v217 adds the operation snapshot table without touching the inventory", async () => {
    const name = `cognia-provider-ops-v217-${Date.now()}`
    const legacy = new Dexie(name)
    legacy.version(216).stores({
      providerConnectionInventory:
        "&id, &deploymentRef, providerRef, status, checkedAt, *availableUpstreamIds",
    })
    await legacy.open()
    await legacy.table("providerConnectionInventory").put({
      id: "deployment:openai-main",
      deploymentRef: "openai-main",
      providerRef: "openai",
      status: "healthy",
      checkedAt: 1,
      availableUpstreamIds: ["gpt-test"],
    })
    legacy.close()

    const upgraded = new CogniaDB(name)
    await upgraded.open()
    expect(upgraded.verno).toBeGreaterThanOrEqual(217)

    // Snapshots are read per provider and per deployment, and one cell is
    // looked up by provider + operation across deployments.
    expect(upgraded.providerOperationSnapshots.schema.primKey.name).toBe("id")
    expect(upgraded.providerOperationSnapshots.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "providerId",
        "deploymentRef",
        "operationId",
        "computedAt",
        "[providerId+operationId]",
      ])
    )

    // The inventory row survives, its new optional columns need no index.
    expect(await upgraded.providerConnectionInventory.get("deployment:openai-main")).toMatchObject({
      deploymentRef: "openai-main",
      availableUpstreamIds: ["gpt-test"],
    })
    expect(await upgraded.providerOperationSnapshots.count()).toBe(0)
    upgraded.close()
  })

  schemaIt("v212 adds the backfill run table and the session keyset index", async () => {
    const name = `cognia-project-mining-v212-${Date.now()}`
    const legacy = new Dexie(name)
    legacy.version(211).stores({ sessions: "id, updatedAt, projectId" })
    await legacy.open()
    await legacy.table("sessions").put({ id: "s1", projectId: "p1", createdAt: 1, updatedAt: 1 })
    legacy.close()

    const upgraded = new CogniaDB(name)
    await upgraded.open()
    expect(upgraded.verno).toBeGreaterThanOrEqual(212)

    // The backfill pages newest to oldest through one workspace, and several
    // sessions routinely share a `createdAt` millisecond — so `id` has to be in
    // the key or a two-part cursor would re-read or skip the tied rows.
    expect(upgraded.sessions.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["[projectId+createdAt+id]", "[projectId+updatedAt]"])
    )
    expect(upgraded.projectMiningRuns.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["projectId", "status", "[projectId+status]"])
    )

    // Purely additive: the existing session survives and no run is invented.
    expect(await upgraded.sessions.get("s1")).toMatchObject({ id: "s1", projectId: "p1" })
    expect(await upgraded.projectMiningRuns.count()).toBe(0)

    upgraded.close()
    await Dexie.delete(name)
  })

  schemaIt("v201 adds host-owned external-agent config heads and revisions", async () => {
    const name = `cognia-external-agent-configs-v201-${Date.now()}`
    const legacy = new Dexie(name)
    legacy.version(200).stores({ sessions: "id, updatedAt" })
    await legacy.open()
    await legacy.table("sessions").put({ id: "session-before-configs", updatedAt: 1 })
    legacy.close()

    const upgraded = new CogniaDB(name)
    await upgraded.open()

    expect(upgraded.verno).toBeGreaterThanOrEqual(201)
    expect(upgraded.externalAgentConfigHeads.schema.primKey.keyPath).toBe("configId")
    expect(upgraded.externalAgentConfigRevisions.schema.primKey.keyPath).toBe("revisionId")
    // `*leaseRuns` is multi-entry so a finished run releases its pins without
    // scanning every revision; `[configId+seq]` gives ordered history.
    const revisionIndexes = upgraded.externalAgentConfigRevisions.schema.indexes
    expect(revisionIndexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["configId", "[configId+seq]", "createdAt", "leaseRuns"])
    )
    expect(revisionIndexes.find((index) => index.name === "leaseRuns")?.multi).toBe(true)
    expect(await upgraded.sessions.get("session-before-configs")).toEqual({
      id: "session-before-configs",
      updatedAt: 1,
    })
    upgraded.close()
  })

  schemaIt("v200 adds compound source/target thread handoff tickets", async () => {
    const name = `cognia-thread-handoff-v200-${Date.now()}`
    const legacy = new Dexie(name)
    legacy.version(199).stores({ sessions: "id, updatedAt" })
    await legacy.open()
    await legacy.table("sessions").put({ id: "session-before-handoff", updatedAt: 1 })
    legacy.close()

    const upgraded = new CogniaDB(name)
    await upgraded.open()

    expect(upgraded.verno).toBeGreaterThanOrEqual(200)
    expect(upgraded.threadHandoffTickets.schema.primKey.keyPath).toEqual(["ticketId", "role"])
    expect(upgraded.threadHandoffTickets.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["ticketId", "role", "state", "expiresAt"])
    )
    expect(await upgraded.sessions.get("session-before-handoff")).toEqual({
      id: "session-before-handoff",
      updatedAt: 1,
    })

    upgraded.close()
    await Dexie.delete(name)
  })

  schemaIt(
    "v156 adds durable workflow waitpoint and event tables",
    async () => {
      const name = `cognia-session-peer-message-v155-${Date.now()}`
      const legacy = new Dexie(name)
      legacy.version(154).stores({ sessions: "id, updatedAt", messages: "id, sessionId" })
      await legacy.open()
      await legacy.table("sessions").put({ id: "session-1", updatedAt: 1 })
      legacy.close()

      const upgraded = new CogniaDB(name)
      await upgraded.open()

      expect(upgraded.verno).toBeGreaterThanOrEqual(156)
      expect(upgraded.tables.map((table) => table.name)).toContain("sessionPeerMessages")
      expect(upgraded.tables.map((table) => table.name)).toEqual(
        expect.arrayContaining(["workflowWaitpoints", "workflowWaitEvents"])
      )
      expect(await upgraded.sessions.get("session-1")).toEqual({ id: "session-1", updatedAt: 1 })

      upgraded.close()
      await Dexie.delete(name)
    },
    30_000
  )

  schemaIt(
    "v157 adds the cross-domain governance ledger tables and indexes",
    async () => {
      const name = `cognia-governance-v157-${Date.now()}`
      const legacy = new Dexie(name)
      legacy.version(156).stores({ sessions: "id, updatedAt" })
      await legacy.open()
      await legacy.table("sessions").put({ id: "session-1", updatedAt: 1 })
      legacy.close()

      const upgraded = new CogniaDB(name)
      await upgraded.open()

      expect(upgraded.verno).toBeGreaterThanOrEqual(157)
      expect(upgraded.tables.map((table) => table.name)).toEqual(
        expect.arrayContaining([
          "governanceDecisions",
          "governanceDecisionEvents",
          "governanceEvidence",
          "governanceLineage",
          "governanceConflicts",
          "governanceProvenance",
        ])
      )
      expect(upgraded.governanceDecisionEvents.schema.indexes.map((index) => index.name)).toContain(
        "[decisionId+sequence]"
      )
      expect(upgraded.governanceProvenance.schema.indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining(["decisionRefs", "evidenceRefs"])
      )
      expect(await upgraded.sessions.get("session-1")).toEqual({ id: "session-1", updatedAt: 1 })

      upgraded.close()
      await Dexie.delete(name)
    },
    30_000
  )

  it("constructs an explicit database name for account-local databases", () => {
    const db = new CogniaDB("cognia-account-acct_one")
    expect(db.name).toBe("cognia-account-acct_one")
    db.close()
  })

  it("reports the owners of live CogniaDB connections", async () => {
    const first = new CogniaDB("cognia-owner-test", "migration:source")
    const second = new CogniaDB("cognia-owner-test", "migration:target")
    await first.open()
    await second.open()

    expect(first.connectionId).not.toBe(second.connectionId)
    expect(getOpenDatabaseConnectionOwners("cognia-owner-test")).toEqual([
      "migration:source",
      "migration:target",
    ])

    first.close()
    second.close()
    expect(getOpenDatabaseConnectionOwners("cognia-owner-test")).toEqual([])
  })

  it("does not seed built-ins until readiness is requested explicitly", async () => {
    const db = getDb()
    await db.open()

    expect(await db.characters.count()).toBe(0)
    expect(await db.skills.count()).toBe(0)

    await whenSeeded()

    expect(await db.characters.count()).toBeGreaterThan(0)
    expect(await db.skills.count()).toBeGreaterThan(0)
  })

  it("backfills workspace roots from legacy directory fields and preserves existing roots", () => {
    const withRoots = {
      id: "proj-roots",
      roots: [{ id: "root-existing", path: "D:/existing", isPrimary: true }],
    }

    expect(backfillRootsForRow(withRoots as never)).toBe(withRoots)
    expect(withRoots.roots).toEqual([{ id: "root-existing", path: "D:/existing", isPrimary: true }])

    const legacy = {
      id: "proj-legacy",
      rootDir: " D:/main ",
      additionalDirs: ["D:/docs", "D:/docs", " "],
    }

    backfillRootsForRow(legacy as never)

    expect((legacy as { roots?: Array<{ path: string; isPrimary?: boolean }> }).roots).toEqual([
      expect.objectContaining({ path: "D:/main", isPrimary: true }),
      expect.objectContaining({ path: "D:/docs", isPrimary: false }),
    ])
  })

  it("opens the selected account database and closes the previous handle on switch", () => {
    activateAccountDatabase("acct_one")
    const first = getDb()
    expect(first.name).toBe("cognia-account-acct_one-encrypted-v1")

    activateAccountDatabase("acct_two")
    const second = getDb()

    expect(second.name).toBe("cognia-account-acct_two-encrypted-v1")
    expect(second).not.toBe(first)
    expect(first.isOpen()).toBe(false)
  })

  it("opens a physically isolated database for an account runtime target", () => {
    activateAccountDatabase("acct_one", "web-standalone")

    expect(getDb().name).toBe("cognia-account-acct_one-target-web-standalone-encrypted-v1")
  })

  it("leaves the cached handle untouched when account selection does not change", () => {
    activateAccountDatabase("acct_one")
    const first = getDb()

    activateAccountDatabase("acct_one")

    expect(getDb()).toBe(first)
  })

  it("can clear account database selection back to the legacy database for migration tests", () => {
    activateAccountDatabase("acct_one")
    expect(getDb().name).toBe("cognia-account-acct_one-encrypted-v1")

    clearAccountDatabaseSelection()
    const legacy = getDb()

    expect(legacy.name).toBe(LEGACY_COGNIA_DB_NAME)
  })

  it("leaves the legacy cached handle untouched when account selection is already clear", () => {
    const legacy = getDb()

    clearAccountDatabaseSelection()

    expect(getDb()).toBe(legacy)
  })

  it("returns a CogniaDB instance with every advertised table wired", () => {
    const db = getDb()
    expect(db).toBeInstanceOf(CogniaDB)
    expect(db.sessions).toBeDefined()
    expect(db.messages).toBeDefined()
    expect(db.settings).toBeDefined()
    expect(db.promptPresets).toBeDefined()
    expect(db.mcpServers).toBeDefined()
    expect(db.mcpSyncJobs).toBeDefined()
    expect(db.mcpCapabilityCache).toBeDefined()
    expect(db.mcpServerSummaries).toBeDefined()
    expect(db.messageMediaRefs).toBeDefined()
    expect(db.chatTurnSummaries).toBeDefined()
    expect(db.chatTranscriptIndexState).toBeDefined()
    expect(db.characters).toBeDefined()
    expect(db.skills).toBeDefined()
    expect(db.skillResources).toBeDefined()
    expect(db.teams).toBeDefined()
    expect(db.trustedWorkspaces).toBeDefined()
    expect(db.backupHistory).toBeDefined()
    expect(db.notifications).toBeDefined()
    expect(db.siteProjects).toBeDefined()
    expect(db.siteVersions).toBeDefined()
    expect(db.siteArtifacts).toBeDefined()
    expect(db.siteEnvironmentRevisions).toBeDefined()
    expect(db.siteDeployments).toBeDefined()
    expect(db.siteOperations).toBeDefined()
    expect(db.siteOperationEvents).toBeDefined()
    expect(db.siteResources).toBeDefined()
    expect(db.canvasDocuments).toBeDefined()
    expect(db.canvasVersions).toBeDefined()
    expect(db.canvasComments).toBeDefined()
    expect(db.contextComments).toBeDefined()
    expect(db.canvasSessions).toBeDefined()
    expect(db.sessionState).toBeDefined()
    expect(db.tts_provider_keys).toBeDefined()
    // §A-Schema (v15), minus the retired pluginScheduledJobs table (v113).
    expect(db.plugins).toBeDefined()
    expect(db.pluginPermissions).toBeDefined()
    expect(db.pluginReviews).toBeDefined()
    expect(db.pluginAnalytics).toBeDefined()
    expect(db.tables.map((table) => table.name)).not.toContain("pluginScheduledJobs")
    // v17 — External Bridge (LLM Wiki + MCP audit) tables.
    expect(db.wikiArticles).toBeDefined()
    expect(db.wikiSections).toBeDefined()
    expect(db.wikiManifest).toBeDefined()
    expect(db.mcpAuditLog).toBeDefined()
    // v18 — Platform Connectors tables.
    expect(db.adapterInstances).toBeDefined()
    expect(db.platformIdentities).toBeDefined()
    expect(db.inboundLedger).toBeDefined()
    expect(db.outboundQueue).toBeDefined()
    expect(db.conversationOverrides).toBeDefined()
    expect(db.connectorAudit).toBeDefined()
    expect(db.connectorDrafts).toBeDefined()
    expect(db.connectorAttachments).toBeDefined()
    // v114 — unified execution journal + IM presentation state.
    expect(db.executionRuns).toBeDefined()
    expect(db.executionRunEvents).toBeDefined()
    expect(db.executionRunBindings).toBeDefined()
    expect(db.executionRunInterrupts).toBeDefined()
    // v51 — Heartbeats split out of connectorAudit into their own table.
    expect(db.connectorHeartbeats).toBeDefined()
    // v27 — Plugin Dexie table registry (M0 platform feature).
    expect(db.pluginDexieMeta).toBeDefined()
    // v49 — Inbox telemetry ring buffer.
    expect(db.inboxTelemetryEvents).toBeDefined()
    // v108 — Local code-adoption tracking.
    expect(db.codeAdoptionTurns).toBeDefined()
    // v109 — user-consent binary ledger.
    expect(db.approvedBinaries).toBeDefined()
    expect(db.browserProfiles).toBeDefined()
    expect(db.browserDomainGrants).toBeDefined()
    expect(db.memoryEvidence).toBeDefined()
    expect(db.memoryJobs).toBeDefined()
    expect(db.memoryAuditEvents).toBeDefined()
    expect(db.retrievalProfiles).toBeDefined()
    expect(db.retrievalGenerations).toBeDefined()
    expect(db.retrievalActivePointers).toBeDefined()
    expect(db.retrievalJobs).toBeDefined()
    expect(db.retrievalTraces).toBeDefined()
    expect(db.retrievalEncryptedContent).toBeDefined()
    expect(db.retrievalTombstones).toBeDefined()
    expect(db.retrievalMigrationJournal).toBeDefined()
    expect(db.retrievalRuntimeState).toBeDefined()
    expect(db.petSpritePacks).toBeDefined()
    expect(db.connectorConversationStates).toBeDefined()
    expect(db.connectorInboundJobs).toBeDefined()
  })

  it("v122 indexes memories by sourceMessageId for chat memory chips", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(122)
    expect(db.memories.schema.indexes.map((index) => index.name)).toContain("sourceMessageId")
  })

  it("v163 opens the shared retrieval control-plane tables", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(163)
    expect(db.tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "retrievalProfiles",
        "retrievalGenerations",
        "retrievalActivePointers",
        "retrievalJobs",
        "retrievalTraces",
        "retrievalEncryptedContent",
        "retrievalTombstones",
        "retrievalMigrationJournal",
      ])
    )
  })

  it("v164 preserves unknown memory governance and expands legacy job outcomes", () => {
    const memory = backfillMemoryGovernanceV164({
      type: "procedural",
      evidenceState: "legacy",
      sensitivity: "normal",
      reviewStatus: "unreviewed",
    } as never)
    expect(memory).toMatchObject({
      confidence: null,
      expiresAt: null,
      staleness: "unknown",
      sensitivity: "unknown",
      reviewStatus: "pending_instruction",
    })
    expect(
      backfillMemoryJobV164({
        status: "completed",
        retryCount: 0,
        startedAt: 10,
      } as never)
    ).toMatchObject({
      status: "succeeded",
      attempt: 1,
      maxAttempts: 4,
      resultCode: "legacy_completed",
    })
  })

  it("v165 indexes all derived RAG chunks by immutable generation", async () => {
    const db = getDb()
    await db.open()
    for (const table of [db.projectChunks, db.knowledgeBaseChunks, db.twinChunks]) {
      expect(table.schema.indexes.map((index) => index.name)).toContain("generationId")
    }
  })

  it("v166 opens the durable retrieval rollout kill switch", async () => {
    const db = getDb()
    await db.open()
    expect(db.retrievalRuntimeState.schema.primKey.name).toBe("id")
  })

  it("v167 indexes memory updatedAt for bounded companion sync", async () => {
    const db = getDb()
    const indexNames = db.memories.schema.indexes.map((index) => index.name)
    expect(indexNames).toContain("updatedAt")
  })

  it("v168 opens the HostState channel, action ledger, and fencing metadata tables", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(168)
    expect(db.hostStateChannels.schema.primKey.name).toBe("channel")
    expect(db.hostStateChannels.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["hostGeneration", "hostSeq", "updatedAt"])
    )
    expect(db.hostStateActions.schema.primKey.name).toBe("[hostGeneration+actionId]")
    expect(db.hostStateActions.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["channel", "hostSeq", "outcome", "broadcastState"])
    )
    expect(db.hostStateMeta.schema.primKey.name).toBe("id")
  })

  it("v169 opens the work submission ledger and its frozen payload stores", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(169)
    expect(db.workSubmissions.schema.primKey.name).toBe("id")
    expect(db.workSubmissions.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "accountId",
        "[accountId+idempotencyKey]",
        "dispatchState",
        // The sweep that retries backed-off work reads this compound index; a
        // missing entry here makes deferred submissions invisible to it.
        "[dispatchState+nextAttemptAt]",
        "runId",
        "sessionId",
      ])
    )
    // Idempotency is enforced by the index, not by application code.
    expect(
      db.workSubmissions.schema.indexes.find((index) => index.name === "[accountId+idempotencyKey]")
        ?.unique
    ).toBe(true)

    for (const table of [db.workInputBatches, db.executionContextBundles]) {
      expect(table.schema.primKey.name).toBe("id")
      expect(table.schema.indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining(["submissionId", "expiresAt"])
      )
      // One frozen payload per submission — a second would make "which input
      // does a retry replay?" ambiguous.
      expect(table.schema.indexes.find((index) => index.name === "submissionId")?.unique).toBe(true)
    }
  })

  it("v193 opens the saved chat templates table with the indexes the picker needs", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(193)

    expect(db.chatTemplates.schema.primKey.name).toBe("id")
    // The picker sorts by recency of use, falling back to recency of edit —
    // both need an index or the list is a full scan on every keystroke.
    expect(db.chatTemplates.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["name", "updatedAt", "lastUsedAt"])
    )
  })

  it("v194 opens the ADR-0149 identity projection with the indexes membership needs", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(194)

    for (const table of [
      db.users,
      db.orgs,
      db.orgMemberships,
      db.workspaceMemberships,
      db.externalIdentities,
    ]) {
      expect(table.schema.primKey.name).toBe("id")
    }

    // Membership is read in both directions — "who is in this org" and "which
    // orgs am I in" — so neither may be a full scan.
    expect(db.orgMemberships.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["orgId", "userId"])
    )
    // Plus "which workspaces do I hold in this org", which is the query the
    // two-tier resolver runs on every workspace switch.
    expect(db.workspaceMemberships.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["workspaceId", "userId", "orgId", "[userId+orgId]"])
    )
    expect(db.externalIdentities.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["userId", "provider"])
    )
    // v196 dropped `updatedAt` here: `ExternalIdentity` never had that field,
    // so the index matched no row. Nothing may put it back.
    expect(db.externalIdentities.schema.indexes.map((index) => index.name)).not.toContain(
      "updatedAt"
    )
    expect(db.orgs.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["logtoOrganizationId"])
    )
  })

  it("v197 opens the collaboration workspace mirror", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(197)
    expect(db.collabWorkspaces.schema.primKey.name).toBe("id")
    // Read by org on every refresh, and sorted by name for the roster page.
    expect(db.collabWorkspaces.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["orgId", "name", "updatedAt", "fetchedAt"])
    )
  })

  it("v198 opens the collaboration plan and run mirrors", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(198)
    expect(db.collabPlans.schema.primKey.name).toBe("id")
    expect(db.collabRuns.schema.primKey.name).toBe("id")
    // Read by org on every refresh and by workspace for the activity panel.
    expect(db.collabPlans.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["orgId", "workspaceId", "status", "updatedAt", "fetchedAt"])
    )
    expect(db.collabRuns.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["orgId", "workspaceId", "issueId", "planId", "status", "startedAt"])
    )
    // Artifacts are read, never queried — an index on them would be dead weight
    // on every write for a lookup nothing performs.
    expect(db.collabRuns.schema.indexes.map((index) => index.name)).not.toContain("artifacts")
  })

  it("v207 opens server-authoritative shared-chat mirrors", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(207)
    expect(db.collabChatSessions.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["orgId", "workspaceId", "[orgId+workspaceId]"])
    )
    expect(db.collabChatMemberships.schema.primKey.name).toBe("[sessionId+userId]")
    expect(db.collabChatEvents.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["sessionId", "[sessionId+sequence]"])
    )
    expect(db.collabChatSyncStates.schema.primKey.name).toBe("sessionId")
  })

  it("v209 opens the shared-chat attachment metadata mirror", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(209)
    expect(db.collabChatAttachments.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["sessionId", "orgId", "status"])
    )
  })

  it("v208 opens the resumable account-content encryption journal", async () => {
    const db = new CogniaDB("cognia-schema-v208-content-encryption")
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(208)
    expect(db.accountContentMigrations.schema.primKey.name).toBe("id")
    expect(db.accountContentMigrations.schema.indexes.map((index) => index.name)).toEqual([
      "accountId",
      "status",
      "updatedAt",
    ])
    db.close()
    await Dexie.delete("cognia-schema-v208-content-encryption")
  })

  it("v196 indexes the external subject the IM plane resolves people by", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(196)
    // `findUserIdByProviderSubject` scans `provider` and filters `subject`
    // when the tenant is unknown; without this index every Lark bind would
    // walk the whole table.
    expect(db.externalIdentities.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["subject", "linkedAt"])
    )
  })

  it("v195 opens the collaboration issue mirror with the indexes the board reads by", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(195)
    expect(db.collabIssues.schema.primKey.name).toBe("id")
    // The board reads by workspace, and a partial refresh replaces by
    // `[orgId+workspaceId]` — both are full scans without an index.
    expect(db.collabIssues.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "orgId",
        "workspaceId",
        "issueProjectId",
        "[orgId+workspaceId]",
        "updatedAt",
      ])
    )
  })

  it("v170 opens the issue tracker tables with the indexes its queries need", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(170)

    expect(db.issues.schema.primKey.name).toBe("id")
    expect(db.issues.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "projectId",
        "issueProjectId",
        "status",
        // "Assigned to me" / per-agent views read this compound index.
        // IndexedDB cannot index the nested `assignee` blob, which is why the
        // row carries mirrored `assigneeKind` / `assigneeId` scalars at all.
        "[assigneeKind+assigneeId]",
        "[issueProjectId+status]",
        "labelIds",
      ])
    )
    // Printed identifiers are shared into commits and chat; a duplicate would
    // make `MERC-2` ambiguous, so uniqueness is enforced by the index.
    expect(db.issues.schema.indexes.find((index) => index.name === "identifier")?.unique).toBe(true)
    expect(db.issues.schema.indexes.find((index) => index.name === "labelIds")?.multi).toBe(true)

    expect(db.issueProjects.schema.primKey.name).toBe("id")
    expect(db.issueProjects.schema.indexes.find((index) => index.name === "key")?.unique).toBe(true)

    // Activity trail shape matches chatGoalEvents / agentPlanEvents / loopEvents.
    expect(db.issueEvents.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["issueId", "[issueId+ts]", "kind", "ts"])
    )

    expect(db.issueCounters.schema.primKey.name).toBe("scopeId")
  })

  it("v170 migrates the conversation label catalogue into `labels` preserving ids", async () => {
    const db = getDb()
    await db.open()

    expect(db.labels.schema.primKey.name).toBe("id")
    expect(db.labels.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["scope", "[scope+name]"])
    )

    // Id preservation is the whole point of the migration: the referencing
    // rows (`conversationOverrides.labelIds[]`, `cannedResponses.labelIds[]`)
    // are never rewritten, so a changed id would silently orphan every tag.
    await db.labels.put({
      id: "lbl-migrated",
      scope: "conversation",
      name: "Follow-up",
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await db.conversationOverrides.put({
      id: "ov-label-ref",
      conversationKey: "k-label-ref",
      sessionId: "s-label-ref",
      labelIds: ["lbl-migrated"],
      createdAt: 1,
      updatedAt: 1,
    } as Parameters<typeof db.conversationOverrides.put>[0])

    const tagged = await db.conversationOverrides.where("labelIds").equals("lbl-migrated").toArray()
    expect(tagged.map((row) => row.id)).toEqual(["ov-label-ref"])

    // The two scopes share one table but never see each other's rows.
    await db.labels.put({
      id: "lbl-issue",
      scope: "issue",
      name: "bug",
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const conversationScoped = await db.labels.where("scope").equals("conversation").toArray()
    expect(conversationScoped.map((row) => row.id)).toContain("lbl-migrated")
    expect(conversationScoped.map((row) => row.id)).not.toContain("lbl-issue")
  })

  it("v171 opens the GitHub issue mirror with its natural key", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(171)
    expect(db.githubIssueMirror.schema.primKey.name).toBe("id")
    expect(db.githubIssueMirror.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["repoFullName", "[repoFullName+number]", "issueProjectId", "state"])
    )
    // A webhook or a re-fetch addresses a row by (repo, number); two rows for
    // one issue would silently double it on the board.
    expect(
      db.githubIssueMirror.schema.indexes.find((index) => index.name === "[repoFullName+number]")
        ?.unique
    ).toBe(true)
  })

  it("v172 indexes the sessionUsage columns the cost surfaces filter on", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(172)
    // `surface` and `providerId` were filtered on without an index, so every
    // Usage-tab read was a full-table scan justified by an unenforced "low
    // thousands of rows" assumption.
    expect(db.sessionUsage.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "surface",
        "providerId",
        "projectId",
        "[projectId+at]",
        "runId",
        "[sessionId+at]",
      ])
    )
    expect(db.sessionUsage.schema.primKey.name).toBe("messageId")
  })

  it("v175 makes host dispatch enqueue-once atomic rather than merely likely", async () => {
    // A read-then-write idempotency check is not atomic: two concurrent
    // enqueues of the same work both saw "no existing row" and both inserted.
    // The unique index is what makes the invariant true.
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(175)
    const index = db.hostDispatchQueue.schema.indexes.find(
      (candidate) => candidate.name === "idempotencyKey"
    )
    expect(index?.unique).toBe(true)
    expect(db.hostDispatchQueue.schema.indexes.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining([
        "accountId",
        "domain",
        "targetRef",
        "status",
        "[status+nextAttemptAt]",
        "[accountId+status]",
        "runId",
      ])
    )
    expect(db.hostDispatchQueue.schema.primKey.name).toBe("id")
  })

  it("v176 makes a run's children queryable instead of a full-table scan", async () => {
    // `parentRunId` existed from v114 but was unindexed, so nothing ever asked
    // "which runs belong to this one?" — the answer cost a scan. Delegation
    // projects children onto ONE card and `retry` links a new run to the run
    // it replaces; both are that question.
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(176)
    expect(db.executionRuns.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["parentRunId", "[parentRunId+status]"])
    )

    const now = Date.now()
    await db.executionRuns.bulkAdd([
      {
        id: "execution:delegation:parent",
        kind: "delegation",
        sourceId: "parent",
        title: "Parent",
        status: "running",
        currentRevision: 0,
        startedAt: now,
        updatedAt: now,
      },
      {
        id: "execution:agent-turn:child",
        parentRunId: "execution:delegation:parent",
        kind: "agent-turn",
        sourceId: "child",
        title: "Child",
        status: "running",
        currentRevision: 0,
        startedAt: now,
        updatedAt: now,
      },
    ])
    const children = await db.executionRuns
      .where("parentRunId")
      .equals("execution:delegation:parent")
      .toArray()
    expect(children.map((run) => run.id)).toEqual(["execution:agent-turn:child"])

    // A root row has no `parentRunId`, so it is absent from the index rather
    // than indexed under a sentinel — which is what makes "no backfill" right.
    expect(children.every((run) => run.parentRunId !== undefined)).toBe(true)
  })

  it("v180 gives a remote device's attachments somewhere to land", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(180)
    // The compound index is what makes the per-(session, device) staging area
    // a lookup rather than a table scan on every init.
    const table = db.table("sessionAttachmentUploads")
    expect(table.schema.primKey.keyPath).toBe("uploadId")
    const indexes = table.schema.indexes.map((index) => index.name)
    expect(indexes).toEqual(expect.arrayContaining(["sessionId", "deviceId", "expiresAt"]))
    expect(indexes.some((name) => name.includes("sessionId") && name.includes("deviceId"))).toBe(
      true
    )
  })

  it("v192 opens durable Human Input request and unique responder submission tables", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(192)
    expect(db.workflowHumanInputRequests.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["waitpointId", "status", "runId", "workflowId", "stepId"])
    )
    expect(db.workflowHumanInputSubmissions.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "requestId",
        "responderId",
        "actionId",
        "submittedAt",
        "sensitiveExpiresAt",
      ])
    )
    expect(
      db.workflowHumanInputSubmissions.schema.indexes.some(
        (index) => index.unique && index.name === "[requestId+responderId]"
      )
    ).toBe(true)
  })

  it("v192 opens durable mobile-step receipts for crash-safe replay guards", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(192)
    expect(db.mobileStepReceipts.schema.primKey.name).toBe("requestId")
    expect(db.mobileStepReceipts.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["deviceId", "status", "[deviceId+status]", "updatedAt", "expiresAt"])
    )
  })

  it("v192 stores encrypted Human Input files with request-scoped retention indexes", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(192)
    expect(db.workflowHumanInputFiles.schema.primKey.name).toBe("id")
    expect(db.workflowHumanInputFiles.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "accountId",
        "requestId",
        "responderId",
        "fieldId",
        "expiresAt",
        "[requestId+responderId]",
      ])
    )
  })

  it("v192 separates mutable app drafts from immutable account-scoped releases", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(192)
    expect(db.workflowApps.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "accountId",
        "workflowId",
        "slug",
        "[accountId+slug]",
        "[accountId+workflowId]",
        "currentReleaseId",
        "updatedAt",
      ])
    )
    expect(
      db.workflowApps.schema.indexes.find((index) => index.name === "[accountId+slug]")?.unique
    ).toBe(true)
    expect(db.workflowAppReleases.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "appId",
        "accountId",
        "workflowId",
        "versionId",
        "sequence",
        "createdAt",
        "[appId+sequence]",
      ])
    )
  })

  it("v192 indexes release-pinned Chatflow history for windows, export, and retention", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(192)
    expect(db.workflowConversations.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "accountId",
        "appId",
        "appReleaseId",
        "versionId",
        "status",
        "updatedAt",
        "expiresAt",
        "[appId+status]",
        "[accountId+status]",
      ])
    )
    expect(db.workflowConversationMessages.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "conversationId",
        "sequence",
        "role",
        "runId",
        "createdAt",
        "expiresAt",
        "[conversationId+sequence]",
      ])
    )
    expect(
      db.workflowConversationMessages.schema.indexes.find(
        (index) => index.name === "[conversationId+sequence]"
      )?.unique
    ).toBe(true)
  })

  it("v192 deduplicates Chatflow messages by conversation-scoped idempotency key", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(192)
    const index = db.workflowConversationMessages.schema.indexes.find(
      (candidate) => candidate.name === "[conversationId+idempotencyKey]"
    )
    expect(index?.unique).toBe(true)
  })

  it("v192 isolates immutable-release batch jobs into independently recoverable rows", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(192)
    expect(db.workflowBatchJobs.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["accountId", "appId", "appReleaseId", "status", "[appId+status]"])
    )
    expect(db.workflowBatchRows.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "accountId",
        "jobId",
        "rowNumber",
        "status",
        "runId",
        "[jobId+rowNumber]",
        "[jobId+status]",
      ])
    )
    expect(
      db.workflowBatchRows.schema.indexes.find((index) => index.name === "[jobId+rowNumber]")
        ?.unique
    ).toBe(true)
  })

  it("v192 stores knowledge pipeline handoffs as expiring encrypted artifacts", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(192)
    expect(db.workflowKnowledgeArtifacts.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "accountId",
        "runId",
        "stepId",
        "stage",
        "expiresAt",
        "[runId+stage]",
      ])
    )
  })

  it("v178 makes the attachment cache accountable and defaults the media policy", async () => {
    // Three defects are pinned here, because each one was silently wrong:
    // the cache had no access stamp to evict by, deleting a row left its
    // ciphertext behind with nothing tracking it, and an adapter row carried
    // no media policy at all — so there was nothing for a gate to read.
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(178)
    expect(db.connectorAttachments.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["cacheKey", "lastAccessedAt"])
    )

    const now = Date.now()
    await db.connectorCleanupJobs.put({
      id: "b".repeat(64),
      adapterId: "tg-1",
      reason: "adapter_removed",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    })
    const job = await db.connectorCleanupJobs.get("b".repeat(64))
    expect(job?.reason).toBe("adapter_removed")
    // Due-job lookup is index-driven, not a full scan.
    expect(await db.connectorCleanupJobs.where("nextAttemptAt").belowOrEqual(now).count()).toBe(1)
  })

  it("v177 indexes the Squad a conversation runs on, separately from its team", async () => {
    // `squadId` (executor) and `teamId` (conversation shape) are different
    // questions about the same row, so the index must answer one without
    // dragging in the other.
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(177)
    expect(db.sessions.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["squadId", "teamId"])
    )

    const now = Date.now()
    await db.sessions.bulkAdd([
      { id: "s-squad", title: "On a squad", createdAt: now, updatedAt: now, squadId: "squad-1" },
      {
        id: "s-team",
        title: "A team room",
        createdAt: now,
        updatedAt: now,
        kind: "team",
        teamId: "team-1",
      },
      {
        id: "s-both",
        title: "Team room on a squad",
        createdAt: now,
        updatedAt: now,
        kind: "team",
        teamId: "team-1",
        squadId: "squad-1",
      },
      { id: "s-plain", title: "Unbound", createdAt: now, updatedAt: now },
    ])

    const onSquad = await db.sessions.where("squadId").equals("squad-1").toArray()
    expect(onSquad.map((session) => session.id).sort()).toEqual(["s-both", "s-squad"])

    // The two axes are independent: querying by team must not pick up the
    // squad-only session, and vice versa.
    const inTeam = await db.sessions.where("teamId").equals("team-1").toArray()
    expect(inTeam.map((session) => session.id).sort()).toEqual(["s-both", "s-team"])

    // An unbound session is absent from the index rather than indexed under a
    // sentinel — which is what makes "no backfill" the right call for the
    // sessions that existed before this version.
    expect(onSquad.every((session) => session.squadId !== undefined)).toBe(true)
  })

  it("v172 indexes agentTraces by run identity and lifecycle status", async () => {
    const db = getDb()
    await db.open()

    expect(db.agentTraces.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["runId", "status", "traceId", "parentSpanId"])
    )
  })

  it("v172 freezes legacy cost provenance without inventing prices", async () => {
    const db = getDb()
    await db.open()

    // An SDK-priced legacy row was already authoritative.
    await db.sessionUsage.put({
      messageId: "m-priced",
      sessionId: "s1",
      at: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0.25,
      durationMs: 0,
      costSource: "sdk",
      costKnown: true,
    })
    // A zero-cost legacy row is genuinely ambiguous after the fact — free
    // model, or a model we had no price for. It must stay unknown rather than
    // being re-priced with today's rates.
    await db.sessionUsage.put({
      messageId: "m-ambiguous",
      sessionId: "s1",
      at: 2,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      durationMs: 0,
      costSource: "backfilled",
      costKnown: false,
    })

    const priced = await db.sessionUsage.get("m-priced")
    expect(priced).toMatchObject({ costSource: "sdk", costKnown: true })
    const ambiguous = await db.sessionUsage.get("m-ambiguous")
    expect(ambiguous).toMatchObject({ costSource: "backfilled", costKnown: false })
  })

  it("v172 round-trips the frozen cost dimensions and execution identity", async () => {
    const db = getDb()
    await db.open()

    await db.sessionUsage.put({
      messageId: "m-frozen",
      sessionId: "s2",
      projectId: "p1",
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      at: 3,
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheCreation5mTokens: 100,
      cacheCreation1hTokens: 200,
      speed: "fast",
      inferenceGeo: "us",
      batch: false,
      unitBreakdown: { requests: { web_search: 2 } },
      priceSnapshot: { promptPer1M: 5, completionPer1M: 25, currency: "USD" },
      costUsd: 1.5,
      costSource: "catalog",
      costKnown: true,
      durationMs: 0,
    })

    const row = await db.sessionUsage.get("m-frozen")
    expect(row).toMatchObject({
      projectId: "p1",
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      cacheCreation5mTokens: 100,
      cacheCreation1hTokens: 200,
      speed: "fast",
      inferenceGeo: "us",
      costSource: "catalog",
      costKnown: true,
    })
    expect(row?.unitBreakdown?.requests?.web_search).toBe(2)
    expect(row?.priceSnapshot?.promptPer1M).toBe(5)

    // The new identity index is queryable, which is what makes a billing row
    // joinable to its span tree.
    const byRun = await db.sessionUsage.where("runId").equals("run-1").toArray()
    expect(byRun.map((r) => r.messageId)).toEqual(["m-frozen"])
  })

  it("v174 opens the issue runs table with the indexes the run bridge queries", async () => {
    const db = getDb()
    await db.open()

    expect(db.verno).toBeGreaterThanOrEqual(174)
    expect(db.issueRuns.schema.primKey.name).toBe("id")
    expect(db.issueRuns.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "issueId",
        "[issueId+status]",
        "projectId",
        "[projectId+status]",
        "adapterId",
        "kind",
        "targetId",
        "status",
      ])
    )
  })

  it("v123 opens the certification projection table", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(123)
    expect(db.agentCompatibilityRecords.schema.primKey.name).toBe("keyId")
    expect(db.agentCompatibilityRecords.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["bundleId", "deploymentRef"])
    )
  })

  it("v124 opens the canonical-session header projection table", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(124)
    expect(db.agentCanonicalSessions.schema.primKey.name).toBe("canonicalSessionId")
    expect(db.agentCanonicalSessions.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["sourceRuntime", "nativeSessionId", "updatedAt"])
    )
  })

  it("v126 opens the Lark entry-surface tables", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(126)
    expect(db.larkEntryContexts.schema.primKey.name).toBe("id")
    expect(db.larkChatSurfaces.schema.primKey.name).toBe("[adapterId+chatId+surfaceType]")
    expect(db.larkMessageImports.schema.indexes.map((index) => index.name)).toContain("sourceHash")
    expect(db.larkWebSessions.schema.primKey.name).toBe("id")
  })

  it("v127 opens the Marketplace Integration control-plane tables", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(127)
    expect(db.integrationAccounts.schema.indexes.map((index) => index.name)).toContain(
      "[pluginId+integrationId+remoteAccountId]"
    )
    expect(db.integrationSubscriptions.schema.indexes.map((index) => index.name)).toContain(
      "accountId"
    )
    expect(db.integrationEvents.schema.indexes.map((index) => index.name)).toContain(
      "[accountId+deliveryId]"
    )
    expect(db.integrationActionJobs.schema.indexes.map((index) => index.name)).toContain("status")
    expect(db.integrationAudit.schema.indexes.map((index) => index.name)).toContain("createdAt")
  })

  it("v139 opens the unified action-review receipt log", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(139)

    const indexes = db.actionReviewReceipts.schema.indexes.map((index) => index.name)
    expect(db.actionReviewReceipts.schema.primKey.name).toBe("id")
    // The retention sweeper is a range delete over this index.
    expect(indexes).toContain("expiresAt")
    // The two compounds the audit UI pages through.
    expect(indexes).toContain("[channel+decidedAt]")
    expect(indexes).toContain("[sessionId+decidedAt]")
    // multiEntry, so a per-surface query is an index hit not a table scan.
    const surfaceIds = db.actionReviewReceipts.schema.indexes.find(
      (index) => index.name === "surfaceIds"
    )
    expect(surfaceIds?.multi).toBe(true)
  })

  it("v140 opens the provider diagnostics control-plane tables", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(140)
    expect(db.providerDiagnosticJobs.schema.indexes.map((index) => index.name)).toContain(
      "[providerId+startedAt]"
    )
    expect(db.providerDiagnosticSamples.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["jobId", "[providerId+startedAt]", "[targetId+startedAt]"])
    )
    expect(db.providerBalanceSnapshots.schema.indexes.map((index) => index.name)).toContain(
      "[providerId+fetchedAt]"
    )
    expect(db.providerEndpointChanges.schema.indexes.map((index) => index.name)).toContain(
      "[providerId+appliedAt]"
    )
  })

  it("v130 partitions sync cursors by host", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(130)

    // Same table, two hosts, both retained — the compound primary key is what
    // stops one host's watermark being used against another.
    await db.hostSyncCursors.bulkPut([
      { serverKey: "host-a", table: "messages", since: 5, lastSyncAt: 1, lastError: null },
      { serverKey: "host-b", table: "messages", since: 900, lastSyncAt: 2, lastError: null },
    ] as never)
    expect(await db.hostSyncCursors.count()).toBe(2)
    expect((await db.hostSyncCursors.get(["host-b", "messages"] as never))?.since).toBe(900)
  })

  it("v134 opens the chat-history search stores", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(134)

    // `messageId` IS the primary key, and that is what makes re-projecting the
    // same message from two of Tauri's WebViews an overwrite instead of a
    // duplicate — the reason no leader election is needed.
    expect(db.chatSearchText.schema.primKey.name).toBe("messageId")
    expect(db.chatSearchText.schema.primKey.unique).toBe(true)
    // `[createdAt+messageId]` rather than `createdAt` alone: messages routinely
    // share a millisecond, and both the resident-corpus load and the
    // older-history scan page through this index.
    expect(db.chatSearchText.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "sessionId",
        "[sessionId+createdAt]",
        "[createdAt+messageId]",
        "projectId",
        "[projectId+createdAt]",
      ])
    )
    expect(db.chatSearchState.schema.primKey.name).toBe("id")
  })

  it("v135 opens the versioned provider catalog stores and indexes", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(135)

    expect(db.providerCatalogRevisions.schema.primKey.name).toBe("id")
    expect(db.providerCatalogModels.schema.primKey.name).toBe("[revisionId+id]")
    expect(db.providerCatalogOfferings.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["revisionId", "[revisionId+providerRef]", "[revisionId+modelRef]"])
    )
    expect(db.providerConnectionInventory.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["deploymentRef", "providerRef", "status", "checkedAt"])
    )
  })

  schemaIt(
    "v150 adds the global agent trace time index without rewriting rows",
    async () => {
      const name = `cognia-agent-trace-v150-${Date.now()}`
      const legacy = new Dexie(name)
      legacy.version(149).stores({
        agentTraces:
          "&id, sessionId, [sessionId+startTime], traceId, [traceId+startTime], parentSpanId, surface, projectId, [projectId+startTime]",
      })
      await legacy.open()
      await legacy.table("agentTraces").bulkPut([
        { id: "old", traceId: "trace-1", sessionId: "session-1", startTime: 10 },
        { id: "new", traceId: "trace-2", sessionId: "session-2", startTime: 20 },
      ])
      legacy.close()

      const upgraded = new CogniaDB(name)
      await upgraded.open()

      expect(upgraded.verno).toBeGreaterThanOrEqual(150)
      expect(upgraded.agentTraces.schema.indexes.map((index) => index.name)).toContain("startTime")
      expect(
        (await upgraded.agentTraces.orderBy("startTime").reverse().toArray()).map((row) => row.id)
      ).toEqual(["new", "old"])

      upgraded.close()
      await Dexie.delete(name)
    },
    30_000
  )

  schemaIt(
    "v152 adds the message media reference ledger and turn indexes",
    async () => {
      const name = `cognia-message-media-refs-v152-${Date.now()}`
      const legacy = new Dexie(name)
      legacy.version(151).stores({
        messages:
          "id, sessionId, [sessionId+createdAt], senderId, platformMessageId, [createdAt+id], projectId, [projectId+createdAt]",
        messageMedia: "&hash, lastUsedAt, createdAt",
      })
      await legacy.open()
      await legacy.table("messages").put({
        id: "legacy-message",
        sessionId: "session-1",
        role: "user",
        parts: [],
        createdAt: 1,
      })
      legacy.close()

      const upgraded = new CogniaDB(name)
      await upgraded.open()

      expect(upgraded.verno).toBeGreaterThanOrEqual(152)
      expect(upgraded.messageMediaRefs.schema.primKey.name).toBe("[messageId+hash]")
      expect(upgraded.messageMediaRefs.schema.indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining(["sessionId", "messageId", "hash", "[sessionId+hash]"])
      )
      expect(upgraded.messages.schema.indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining(["turnKey", "[sessionId+turnKey]"])
      )
      expect(await upgraded.messages.get("legacy-message")).toBeDefined()

      upgraded.close()
      await Dexie.delete(name)
    },
    30_000
  )

  schemaIt("v160 opens encrypted performance evidence tables", async () => {
    const name = `cognia-performance-captures-v160-${Date.now()}`
    const legacy = new Dexie(name)
    legacy.version(159).stores({ sessions: "&id" })
    await legacy.open()
    legacy.close()

    const upgraded = new CogniaDB(name)
    await upgraded.open()
    expect(upgraded.verno).toBeGreaterThanOrEqual(160)
    expect(upgraded.tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "performanceCaptures",
        "performanceCaptureChunks",
        "performanceCaptureAttachments",
        "performanceCaptureGaps",
      ])
    )
    await upgraded.performanceCaptures.put({
      id: "capture-a",
      status: "recording",
      purpose: "capture",
      sourceKind: "renderer",
      sourceId: "renderer:doc-a",
      hostInstanceId: "doc-a",
      targetId: "target-a",
      routingGeneration: 1,
      wireVersion: 1,
      metricSchemaVersion: 1,
      capabilityBits: "renderer.fps",
      startedAt: 1,
      updatedAt: 1,
      pinned: 0,
      payloadBytes: 0,
      attachmentBytes: 0,
      frameCount: 0,
      gapCount: 0,
    })
    expect((await upgraded.performanceCaptures.get("capture-a"))?.status).toBe("recording")

    upgraded.close()
    await Dexie.delete(name)
  })

  schemaIt("v162 adds the local Matrix encrypted-event recovery queue", async () => {
    const name = `cognia-matrix-pending-v162-${Date.now()}`
    const legacy = new Dexie(name)
    legacy.version(161).stores({ adapterInstances: "&id, type" })
    await legacy.open()
    legacy.close()

    const upgraded = new CogniaDB(name)
    await upgraded.open()

    expect(upgraded.verno).toBeGreaterThanOrEqual(162)
    expect(upgraded.tables.map((table) => table.name)).toContain("matrixPendingEncryptedEvents")
    expect(upgraded.matrixPendingEncryptedEvents.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["[adapterId+eventId]", "[adapterId+state+nextAttemptAt]"])
    )

    upgraded.close()
    await Dexie.delete(name)
  })

  it("v143 leaves an already-migrated sandbox row untouched", async () => {
    const name = `cognia-v143-idempotent-${Date.now()}`
    const first = new CogniaDB(name)
    await first.open()
    await first.sandboxConnections.put({
      id: "conn_new",
      name: "cloud",
      provider: "cua-cloud",
      driver: "cua-driver",
      config: { provider: "cua-cloud", instanceName: "desk-1", instanceId: "i-1" },
      state: "suspended",
      capabilities: {
        create: true,
        connect: true,
        start: true,
        suspend: true,
        resume: true,
        stop: true,
        delete: true,
        health: true,
        gui: true,
        workspaceRead: true,
        workspaceExec: true,
      },
      lastHealthStatus: "unknown",
      createdAt: 1,
      updatedAt: 1,
    })
    first.close()

    // Re-opening runs the upgrade chain again; the row must come back verbatim
    // rather than being re-migrated into a Docker shape.
    const reopened = new CogniaDB(name)
    await reopened.open()
    const row = await reopened.sandboxConnections.get("conn_new")
    expect(row).toMatchObject({
      provider: "cua-cloud",
      state: "suspended",
      config: { provider: "cua-cloud", instanceName: "desk-1", instanceId: "i-1" },
    })
    expect(row).not.toHaveProperty("image")

    reopened.close()
    await Dexie.delete(name)
  }, 30_000)

  schemaIt(
    "v144 adds device-local project environment and CDP metadata indexes",
    async () => {
      const name = `cognia-v144-codex-workflows-${Date.now()}`
      const legacy = new Dexie(name)
      legacy.version(143).stores({ projects: "&id, lastAccessedAt" })
      await legacy.open()
      await legacy.table("projects").put({ id: "project-1", lastAccessedAt: new Date(1) })
      legacy.close()

      const upgraded = new CogniaDB(name)
      await upgraded.open()
      expect(upgraded.verno).toBeGreaterThanOrEqual(144)
      expect((await upgraded.projects.get("project-1"))?.id).toBe("project-1")

      await upgraded.projectEnvironments.put({
        id: "env-1",
        projectId: "project-1",
        name: "Development",
        isEnabled: true,
        setupScript: { default: "pnpm install" },
        actions: [],
        variables: {},
        keyringReferences: [],
        createdAt: 1,
        updatedAt: 2,
      })
      await upgraded.cdpGrants.put({
        id: "grant-1",
        sessionId: "session-1",
        browserSessionId: "browser-1",
        origin: "http://localhost:3000",
        capabilities: ["dom"],
        grantedAt: 1,
        expiresAt: 10,
      })
      await upgraded.cdpAuditEvents.put({
        id: "audit-1",
        grantId: "grant-1",
        sessionId: "session-1",
        browserSessionId: "browser-1",
        origin: "http://localhost:3000",
        outcome: "granted",
        createdAt: 2,
      })

      expect(
        await upgraded.projectEnvironments.where("projectId").equals("project-1").count()
      ).toBe(1)
      expect(
        await upgraded.cdpGrants
          .where("[sessionId+expiresAt]")
          .between(["session-1", Dexie.minKey], ["session-1", Dexie.maxKey])
          .count()
      ).toBe(1)
      expect(
        await upgraded.cdpAuditEvents
          .where("[sessionId+createdAt]")
          .between(["session-1", Dexie.minKey], ["session-1", Dexie.maxKey])
          .count()
      ).toBe(1)

      upgraded.close()
      await Dexie.delete(name)
    },
    30_000
  )

  schemaIt(
    "v145 adds device-local durable AgentTeam runtime tables",
    async () => {
      const name = `cognia-v145-agent-team-runtime-${Date.now()}`
      const legacy = new Dexie(name)
      legacy.version(144).stores({ projects: "&id, lastAccessedAt" })
      await legacy.open()
      await legacy.table("projects").put({ id: "project-1", lastAccessedAt: new Date(1) })
      legacy.close()

      const upgraded = new CogniaDB(name)
      await upgraded.open()
      expect(upgraded.verno).toBeGreaterThanOrEqual(145)
      expect((await upgraded.projects.get("project-1"))?.id).toBe("project-1")

      await upgraded.agentTeamRuns.put({
        id: "run-1",
        teamId: "team-1",
        projectId: "project-1",
        objective: "Recover",
        status: "recovering",
        priority: 1,
        decisionVersion: 0,
        createdAt: 1,
        updatedAt: 2,
      })
      await upgraded.agentTeamTrajectory.put({
        id: "run-1:1",
        runId: "run-1",
        sequence: 1,
        kind: "checkpoint",
        correlationId: "checkpoint-1",
        createdAt: 2,
      })

      expect(await upgraded.agentTeamRuns.where("status").equals("recovering").count()).toBe(1)
      expect(
        await upgraded.agentTeamTrajectory
          .where("[runId+sequence]")
          .between(["run-1", Dexie.minKey], ["run-1", Dexie.maxKey])
          .count()
      ).toBe(1)

      upgraded.close()
      await Dexie.delete(name)
    },
    30_000
  )

  schemaIt(
    "v146 adds reusable Knowledge Base ownership and ingest tables",
    async () => {
      const name = `cognia-v146-knowledge-bases-${Date.now()}`
      const legacy = new Dexie(name)
      legacy.version(145).stores({ characters: "&id, name, updatedAt" })
      await legacy.open()
      await legacy.table("characters").put({
        id: "agent-1",
        name: "Research Agent",
        updatedAt: 1,
      })
      legacy.close()

      const upgraded = new CogniaDB(name)
      await upgraded.open()

      expect(upgraded.verno).toBeGreaterThanOrEqual(146)
      expect((await upgraded.characters.get("agent-1"))?.name).toBe("Research Agent")
      await upgraded.knowledgeBases.put({
        id: "kb-1",
        name: "Product",
        createdAt: 1,
        updatedAt: 1,
      })
      await upgraded.knowledgeBaseSources.put({
        id: "source-1",
        knowledgeBaseId: "kb-1",
        kind: "document",
        format: "markdown",
        title: "Guide",
        content: "hello",
        bytes: 5,
        fingerprint: "sha256:one",
        status: "ready",
        chunkCount: 1,
        createdAt: 1,
        updatedAt: 2,
      })
      await upgraded.knowledgeBaseIngestJobs.put({
        id: "job-1",
        knowledgeBaseId: "kb-1",
        sourceId: "source-1",
        status: "completed",
        phase: "completed",
        progress: 100,
        attempts: 1,
        queuedAt: 1,
        completedAt: 2,
        updatedAt: 2,
      })

      expect(
        await upgraded.knowledgeBaseSources
          .where("[knowledgeBaseId+updatedAt]")
          .between(["kb-1", Dexie.minKey], ["kb-1", Dexie.maxKey])
          .count()
      ).toBe(1)
      expect(
        await upgraded.knowledgeBaseIngestJobs
          .where("[knowledgeBaseId+status]")
          .equals(["kb-1", "completed"])
          .count()
      ).toBe(1)

      upgraded.close()
      await Dexie.delete(name)
    },
    30_000
  )

  schemaIt(
    "v147 adds portable single-Agent tasks and append-only attempts",
    async () => {
      const name = `cognia-v147-agent-tasks-${Date.now()}`
      const legacy = new Dexie(name)
      legacy.version(146).stores({ characters: "&id, name, updatedAt" })
      await legacy.open()
      await legacy.table("characters").put({ id: "agent-1", name: "Agent", updatedAt: 1 })
      legacy.close()

      const upgraded = new CogniaDB(name)
      await upgraded.open()

      expect(upgraded.verno).toBeGreaterThanOrEqual(147)
      expect((await upgraded.characters.get("agent-1"))?.name).toBe("Agent")
      await upgraded.agentTasks.put({
        id: "task-1",
        agentId: "agent-1",
        title: "Ship",
        description: "Ship safely",
        status: "pending",
        priority: "high",
        dependencies: [],
        tags: [],
        order: 0,
        approvalPolicy: "on-risk",
        latestAttemptNo: 1,
        comments: [],
        createdAt: 1,
        updatedAt: 2,
        revision: 1,
      })
      await upgraded.agentTaskAttempts.put({
        id: "attempt-1",
        taskId: "task-1",
        agentId: "agent-1",
        attemptNo: 1,
        status: "failed",
        errorCode: "provider_unavailable",
        createdAt: 2,
        completedAt: 3,
        updatedAt: 3,
      })

      expect(
        await upgraded.agentTasks.where("[agentId+status]").equals(["agent-1", "pending"]).count()
      ).toBe(1)
      expect(
        await upgraded.agentTaskAttempts.where("[taskId+attemptNo]").equals(["task-1", 1]).count()
      ).toBe(1)

      upgraded.close()
      await Dexie.delete(name)
    },
    30_000
  )

  it("v128 opens the content-addressed chat media store", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(128)
    // The content hash IS the primary key — storing the same screenshot from
    // twenty turns must not store it twenty times.
    expect(db.messageMedia.schema.primKey.name).toBe("hash")
    expect(db.messageMedia.schema.primKey.unique).toBe(true)
    expect(db.messageMedia.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["createdAt", "lastUsedAt"])
    )
  })

  it("v125 opens the Feishu unified identity registry tables", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(125)
    expect(db.feishuTenants.schema.primKey.name).toBe("id")
    expect(db.feishuTenants.schema.indexes.map((index) => index.name)).toContain(
      "[tenantKey+appId]"
    )
    expect(db.feishuPrincipals.schema.indexes.map((index) => index.name)).toContain(
      "[tenantKey+appId+openId]"
    )
    expect(db.feishuPrincipalBindRequests.schema.primKey.name).toBe("id")
  })

  it("v121 opens the Provider Profile Store tables and seeds meta", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(121)
    expect(db.providerProfiles.schema.primKey.name).toBe("id")
    expect(db.deploymentProfiles.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["providerRef", "legacyProviderId"])
    )
    expect(db.transportProfiles.schema.primKey.name).toBe("id")
    // Fresh installs skip upgrade hooks (Dexie), so the CAS meta singleton
    // appears on the first derived write, not at open time. Accessors treat
    // a missing row as profileVersion 0.
    expect(await db.profileStoreMeta.get("singleton")).toBeUndefined()
  })

  it("v120 opens durable connector conversation and inbound job tables", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(120)
    expect(db.connectorConversationStates.schema.primKey.name).toBe("conversationKey")
    expect(db.connectorConversationStates.schema.indexes.map((index) => index.name)).toContain(
      "activationStatus"
    )
    expect(db.connectorInboundJobs.schema.indexes.map((index) => index.name)).toContain(
      "[adapterId+platformMessageId]"
    )
    expect(db.connectorInboundJobs.schema.indexes.map((index) => index.name)).toContain(
      "[conversationKey+status+receivedAt]"
    )
  })

  it("v119 opens petSpritePacks with displayName and createdAt indexes", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(119)
    expect(db.petSpritePacks.schema.primKey.name).toBe("id")
    expect(db.petSpritePacks.schema.primKey.unique).toBe(true)
    expect(db.petSpritePacks.schema.indexes.map((index) => index.name)).toEqual([
      "displayName",
      "createdAt",
    ])
  })

  it("v118 opens memory governance tables and preserves legacy rows explicitly", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(118)
    expect(db.memoryEvidence.schema.indexes.map((index) => index.name)).toContain(
      "[memoryId+createdAt]"
    )
    expect(db.memoryJobs.schema.indexes.map((index) => index.name)).toContain("[status+queuedAt]")

    const legacy = backfillMemoryGovernanceV118({} as never)
    expect(legacy).toMatchObject({
      evidenceState: "legacy",
      reviewStatus: "unreviewed",
      contaminationState: "unknown",
      sensitivity: "normal",
    })
  })

  it("v117 opens host-local remote browser profile and domain-grant tables", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(117)
    expect(db.browserProfiles.schema.indexes.map((index) => index.name)).toContain(
      "[workspaceId+updatedAt]"
    )
    expect(db.browserDomainGrants.schema.indexes.map((index) => index.name)).toContain(
      "[workspaceId+domain]"
    )
  })

  it("v116 opens the Cognia Sites lifecycle tables and compound indexes", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(116)
    expect(db.siteProjects.schema.indexes.map((index) => index.name)).toContain(
      "[projectId+sourceRoot+sourceSubpath+executionTargetKey]"
    )
    expect(db.siteVersions.schema.indexes.map((index) => index.name)).toContain("[siteId+sequence]")
    expect(db.siteOperationEvents.schema.indexes.map((index) => index.name)).toContain(
      "[operationId+sequence]"
    )
  })

  it("v114 opens the unified execution journal and its compound indexes", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(114)
    expect(db.executionRuns.schema.indexes.map((index) => index.name)).toContain("[kind+sourceId]")
    expect(db.executionRunEvents.schema.indexes.map((index) => index.name)).toContain("[runId+seq]")
    expect(db.executionRunBindings.schema.indexes.map((index) => index.name)).toContain(
      "[runId+conversationKey]"
    )
    expect(db.executionRunInterrupts.schema.indexes.map((index) => index.name)).toContain(
      "[runId+status]"
    )
  })

  it("v108 stores a code-adoption turn and resolves its indexes", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(108)
    await db.codeAdoptionTurns.bulkPut([
      {
        id: "s1:1",
        runId: 1,
        sessionId: "s1",
        workspaceRoot: "/repo",
        agentKind: "in-app",
        model: "opus",
        ts: 100,
        totalFiles: 1,
        totalAdded: 3,
        totalRemoved: 0,
        files: [{ path: "a.ts", added: 3, removed: 0, isNew: true, hunks: [[1, 3]] }],
        truncated: false,
      },
      {
        id: "s1:2",
        runId: 2,
        sessionId: "s1",
        workspaceRoot: "/repo",
        agentKind: "in-app",
        model: "opus",
        ts: 200,
        totalFiles: 0,
        totalAdded: 0,
        totalRemoved: 0,
        files: [],
        truncated: false,
      },
    ])
    expect(await db.codeAdoptionTurns.where("sessionId").equals("s1").count()).toBe(2)
    expect(await db.codeAdoptionTurns.where("runId").equals(2).count()).toBe(1)
    expect(await db.codeAdoptionTurns.where("workspaceRoot").equals("/repo").count()).toBe(2)
    expect(
      await db.codeAdoptionTurns.where("[sessionId+ts]").between(["s1", 150], ["s1", 300]).count()
    ).toBe(1)
  })

  // v109 — binary trust-model rebuild. Two guarantees: the new consent ledger
  // resolves its compound key + indexes, and the upgrade hook retires the v39
  // placeholder seed from databases that already drank it — WITHOUT touching
  // rows the user populated themselves.
  it("v109 approvedBinaries round-trips on its compound key and indexes", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(109)

    await db.approvedBinaries.bulkPut([
      {
        pluginId: "acme.ext",
        binaryPath: "/plugins/acme.ext/server/lsp",
        sha256: "a".repeat(64),
        approvedAt: 100,
      },
      {
        pluginId: "acme.ext",
        binaryPath: "/plugins/acme.ext/bin/fmt",
        sha256: "b".repeat(64),
        approvedAt: 200,
      },
      {
        pluginId: "other.ext",
        binaryPath: "/plugins/other.ext/bin/tool",
        sha256: "c".repeat(64),
        approvedAt: 300,
      },
    ])

    // Compound primary key resolves an exact (pluginId, binaryPath) pair.
    expect(await db.approvedBinaries.get(["acme.ext", "/plugins/acme.ext/bin/fmt"])).toEqual(
      expect.objectContaining({ sha256: "b".repeat(64), approvedAt: 200 })
    )
    // Same path under a different plugin is a different row — approvals never
    // cross plugin boundaries.
    expect(await db.approvedBinaries.where("pluginId").equals("acme.ext").count()).toBe(2)
    expect(await db.approvedBinaries.where("sha256").equals("c".repeat(64)).count()).toBe(1)
    expect(await db.approvedBinaries.where("approvedAt").above(150).count()).toBe(2)
  })

  // v110 — recorded browser flows (ADR-0072). Pure additive: no upgrade hook,
  // so the guarantee to pin is that the table and its indexes resolve, and that
  // a flow survives the round-trip with its nested step list intact.
  it("v110 browserRecordings round-trips and resolves its indexes", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(110)

    await db.browserRecordings.bulkPut([
      {
        id: "f1",
        name: "login",
        baseUrl: "http://localhost:3000",
        createdAt: 100,
        updatedAt: 100,
        steps: [
          { act: "navigate", at: 0, url: "http://localhost:3000/login" },
          {
            act: "click",
            at: 1,
            target: { selector: "#go", role: "button", name: "Go", domPath: "form > button" },
          },
        ],
      },
      {
        id: "f2",
        name: "checkout",
        baseUrl: "http://localhost:3000",
        createdAt: 200,
        updatedAt: 300,
        steps: [],
      },
      {
        id: "f3",
        name: "other app",
        baseUrl: "http://localhost:4000",
        createdAt: 400,
        updatedAt: 400,
        steps: [],
      },
    ])

    // The nested step list survives structured cloning — a flow is stored whole.
    expect((await db.browserRecordings.get("f1"))?.steps).toHaveLength(2)
    // baseUrl scopes the pane's "flows for this origin" list.
    expect(
      await db.browserRecordings.where("baseUrl").equals("http://localhost:3000").count()
    ).toBe(2)
    // updatedAt drives recency ordering.
    expect(await db.browserRecordings.where("updatedAt").above(150).count()).toBe(2)
    // The compound index backs "this origin's flows, newest first".
    expect(
      await db.browserRecordings
        .where("[baseUrl+updatedAt]")
        .between(["http://localhost:3000", Dexie.minKey], ["http://localhost:3000", Dexie.maxKey])
        .count()
    ).toBe(2)
  })

  it("v111 browserAnnotations round-trips and resolves its compound index", async () => {
    const db = new CogniaDB()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(111)
    await db.browserAnnotations.put({
      id: "a1",
      sessionId: "s1",
      baseUrl: "http://localhost:3000",
      selection: {
        paneId: "browser-pane",
        tagName: "BUTTON",
        selector: "button",
        domPath: "main > button",
        id: null,
        classes: null,
        rect: { x: 0, y: 0, width: 100, height: 40 },
        outerHTML: "<button>Save</button>",
        text: "Save",
        pageUrl: "http://localhost:3000",
        pageTitle: "Home",
      },
      comment: "Fix contrast",
      intent: "fix",
      severity: "important",
      status: "pending",
      thread: [],
      createdAt: 1,
      updatedAt: 1,
    })
    expect(
      await db.browserAnnotations
        .where("[baseUrl+status]")
        .equals(["http://localhost:3000", "pending"])
        .count()
    ).toBe(1)
    db.close()
  })

  it("v112 behaviorEvents round-trips and resolves its compound index", async () => {
    const db = new CogniaDB()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(112)
    await db.behaviorEvents.put({
      id: "event-1",
      eventName: "chat.message.sent",
      at: 1,
      sessionId: "session-1",
      attributes: { provider: "anthropic" },
    })
    expect(
      await db.behaviorEvents.where("[eventName+at]").equals(["chat.message.sent", 1]).first()
    ).toEqual(expect.objectContaining({ id: "event-1" }))
    db.close()
  })

  it("v113 removes the unused pluginScheduledJobs table", async () => {
    const db = new CogniaDB()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(113)
    expect(db.tables.map((table) => table.name)).not.toContain("pluginScheduledJobs")
    db.close()
  })

  // v49 — Inbox optimization pass: messages.platformMessageId index + new
  // telemetry table. Verify the messages table accepts a row with the
  // denormalized field and the index resolves it; the telemetry table
  // accepts inserts via its primary key.
  it("v49 messages.platformMessageId index + inboxTelemetryEvents round-trip", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(49)
    const now = Date.now()

    // Messages row carries the new denormalized field + matching metadata.
    await db.messages.put({
      id: "m-v49",
      sessionId: "s-v49",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      platformMessageId: "tg:msg-42",
      metadata: {
        platformMessage: {
          messageId: "tg:msg-42",
          platform: "telegram",
          sender: {
            id: "u-alice",
            platform: "telegram",
            adapterId: "tg-1",
            remoteUserId: "999",
            displayName: "Alice",
          },
        },
      },
      createdAt: now,
    })
    const byIndex = await db.messages.where("platformMessageId").equals("tg:msg-42").toArray()
    expect(byIndex).toHaveLength(1)
    expect(byIndex[0].id).toBe("m-v49")

    // Rows without platformMessageId still index-skip cleanly.
    await db.messages.put({
      id: "m-v49-no-pm",
      sessionId: "s-v49",
      role: "assistant",
      parts: [{ type: "text", text: "reply" }],
      createdAt: now,
    })
    expect(await db.messages.where("platformMessageId").equals("tg:msg-42").count()).toBe(1)

    // Telemetry table inserts via primary key + lists newest-first via the
    // `at` index.
    await db.inboxTelemetryEvents.bulkPut([
      { id: "te-1", kind: "inbound.received", at: 100, adapterId: "tg-1" },
      { id: "te-2", kind: "outbound.sent", at: 200, adapterId: "tg-1" },
      { id: "te-3", kind: "breaker.open", at: 300, adapterId: "tg-1" },
    ])
    const newest = await db.inboxTelemetryEvents.orderBy("at").reverse().limit(2).toArray()
    expect(newest.map((r) => r.id)).toEqual(["te-3", "te-2"])
  })

  // v82 — Judge calibration loop. Both new tables accept rows via their primary
  // keys and resolve via the [setId+createdAt] compound index.
  it("v82 calibrationItems + calibrationRuns round-trip", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(82)

    await db.calibrationItems.bulkPut([
      {
        id: "calit-1",
        setId: "set-a",
        criterion: "task completion",
        rubric: "Pass only if complete.",
        input: "q",
        output: "a",
        goldLabel: "pass",
        source: "handwritten",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "calit-2",
        setId: "set-a",
        criterion: "task completion",
        rubric: "Pass only if complete.",
        input: "q2",
        output: "a2",
        goldLabel: "fail",
        source: "handwritten",
        createdAt: 2,
        updatedAt: 2,
      },
    ])
    const inSet = await db.calibrationItems.where("setId").equals("set-a").toArray()
    expect(inSet).toHaveLength(2)

    await db.calibrationRuns.put({
      runId: "calrun-1",
      setId: "set-a",
      criterion: "task completion",
      rubric: "Pass only if complete.",
      judgeModel: "claude-sonnet-4-6",
      itemCount: 2,
      scoredCount: 2,
      erroredCount: 0,
      metrics: {
        matrix: { tp: 1, fp: 0, tn: 1, fn: 0 },
        n: 2,
        tpr: 1,
        tnr: 1,
        precision: 1,
        f1: 1,
        accuracy: 1,
        cohenKappa: 1,
      },
      verdicts: [],
      createdAt: 10,
    })
    expect(await db.calibrationRuns.get("calrun-1")).toMatchObject({ setId: "set-a" })
  })

  // v83 — Connector CRM. New status / *labelIds indexes on conversationOverrides
  // and the three new catalog/trail/library tables round-trip.
  it("v83 connector CRM tables + override indexes round-trip", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(83)

    await db.conversationOverrides.bulkPut([
      {
        id: "ov-1",
        conversationKey: "discord:a:ch1",
        sessionId: "s1",
        status: "open",
        labelIds: ["lbl-vip", "lbl-bug"],
        assigneeKind: "team",
        assignee: { kind: "team", id: "team-7", label: "Support" },
        nextResponseDueAt: 5000,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "ov-2",
        conversationKey: "discord:a:ch2",
        sessionId: "s2",
        status: "resolved",
        labelIds: ["lbl-vip"],
        createdAt: 2,
        updatedAt: 2,
      },
    ])
    // status index
    expect(await db.conversationOverrides.where("status").equals("open").count()).toBe(1)
    // multi-entry *labelIds index
    const vip = await db.conversationOverrides.where("labelIds").equals("lbl-vip").toArray()
    expect(vip.map((r) => r.id).sort()).toEqual(["ov-1", "ov-2"])

    await db.conversationLabels.put({
      id: "lbl-vip",
      // v170 moved the catalogue into the shared, scope-discriminated table;
      // the row shape gained a required `scope`.
      scope: "conversation",
      name: "VIP",
      color: "#f00",
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(await db.conversationLabels.get("lbl-vip")).toMatchObject({ name: "VIP" })

    await db.conversationAssignmentEvents.bulkPut([
      { id: "ev-1", conversationKey: "discord:a:ch1", kind: "assigned", at: 10 },
      { id: "ev-2", conversationKey: "discord:a:ch1", kind: "status.resolved", at: 20 },
    ])
    const trail = await db.conversationAssignmentEvents
      .where("[conversationKey+at]")
      .between(["discord:a:ch1", 0], ["discord:a:ch1", Infinity])
      .toArray()
    expect(trail.map((e) => e.id)).toEqual(["ev-1", "ev-2"])

    await db.cannedResponses.put({
      id: "cr-1",
      title: "Greeting",
      body: "Hi {{contact.name}}",
      labelIds: ["lbl-vip"],
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(await db.cannedResponses.get("cr-1")).toMatchObject({ title: "Greeting" })
  })

  // v49 upgrade hook backfills platformMessageId from
  // metadata.platformMessage.messageId on pre-existing rows.
  // v85 upgrade hook backfills the denormalized platformConversationKey index
  // column from each session's existing platformBinding.conversationKey, so
  // multi-session enumeration (control-plane /new /switch /sessions) can query
  // the index instead of full-scanning.
  // v86 — Workspace (Project) isolation. The upgrade backfills `projectId`
  // across every runtime table, attributing sessions via the legacy
  // `Project.sessionIds[]` reverse map and falling back to an auto-created
  // Default workspace when no project is active. End-to-end through the
  // production schema (v85 → v86), exercising the real index + upgrade hook.
  // v131 — Session lineage repair. Branch sessions and workbench sidechats were
  // written straight to Dexie without a `projectId`, which does not merely
  // mis-scope them: `[projectId+updatedAt]` omits any row whose key path
  // contains `undefined`, so they were absent from every scoped read (the
  // sidebar) and from `deleteProjectCascade`. End-to-end through the production
  // schema (v130 → v131), exercising the real index + upgrade hook.
  // v91 — Denormalised `triggeredBySource` index on `workflowRuns`. The upgrade
  // backfills the new top-level column from `triggeredBy.source` (legacy rows
  // with no `triggeredBy` default to "ui"), and the new index resolves only the
  // IM-triggered runs the progress-runner cares about. End-to-end through the
  // production schema (v90 → v91), exercising the real index + upgrade hook.
  // v102 — `triggerKind` index on `workflowRuns`. The Agent-Team runs list
  // (`components/agent/team/runs-list.tsx`) and the CLI status projection
  // (`lib/cli-bridge/handlers/agent-team.ts`) both resolve team runs via
  // `.where("triggerKind").equals("trigger.team")`. Before v102 that keyPath was
  // never indexed, so Dexie threw `SchemaError: KeyPath triggerKind on object
  // store workflowRuns is not indexed` on first render of the team workspace.
  // `triggerKind` is a required top-level column stamped at run creation, so
  // (unlike v91's derived `triggeredBySource`) no backfill runs — the new index
  // simply resolves existing rows. Opens v101 → production schema end-to-end.
  schemaIt(
    "v102 indexes workflowRuns.triggerKind so team runs resolve without a SchemaError",
    async () => {
      const Dexie = (await import("dexie")).default
      const legacy = new Dexie("cognia-claude")
      // Open at v101 with the pre-v102 workflowRuns index (no triggerKind).
      legacy.version(101).stores({
        workflowRuns:
          "&id, workflowId, status, startedAt, completedAt, [workflowId+startedAt], [workflowId+status], projectId, [projectId+startedAt], triggeredBySource, [triggeredBySource+startedAt]",
      })
      await legacy.open()
      await legacy.table("workflowRuns").bulkPut([
        {
          id: "run-team",
          workflowId: "wf-team",
          status: "succeeded",
          startedAt: 1,
          triggerKind: "trigger.team",
        },
        {
          id: "run-manual",
          workflowId: "wf-1",
          status: "succeeded",
          startedAt: 2,
          triggerKind: "trigger.manual",
        },
        {
          id: "run-cron",
          workflowId: "wf-2",
          status: "running",
          startedAt: 3,
          triggerKind: "trigger.cron",
        },
      ])
      legacy.close()

      // Re-open through production schema — v102 adds the triggerKind index.
      const db = getDb()
      await db.open()
      expect(db.verno).toBeGreaterThanOrEqual(102)

      // The exact query the runs list issues — threw the SchemaError before v102,
      // now resolves only the team-triggered run.
      const teamRuns = await db.workflowRuns
        .where("triggerKind")
        .equals("trigger.team")
        .primaryKeys()
      expect(teamRuns).toEqual(["run-team"])
    }
  )

  it("v103 adds the teamPrObservations table with team/run/status indexes", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(103)

    const at = 100
    await db.teamPrObservations.bulkPut([
      {
        id: "r1:pr1",
        runId: "r1",
        teamId: "team-a",
        teammateId: "m1",
        taskId: "t1",
        prUrl: "pr1",
        branch: "b1",
        repo: "o/n",
        facts: {} as never,
        derivedStatus: "ci_failed",
        lastNudgeSignature: {},
        observedAt: at,
        updatedAt: at,
      },
      {
        id: "r1:pr2",
        runId: "r1",
        teamId: "team-a",
        teammateId: "m2",
        taskId: "t2",
        prUrl: "pr2",
        branch: "b2",
        repo: "o/n",
        facts: {} as never,
        derivedStatus: "mergeable",
        lastNudgeSignature: {},
        observedAt: at,
        updatedAt: at + 5,
      },
      {
        id: "r2:pr3",
        runId: "r2",
        teamId: "team-b",
        teammateId: "m3",
        taskId: "t3",
        prUrl: "pr3",
        branch: "b3",
        repo: "o/n",
        facts: {} as never,
        derivedStatus: "pr_open",
        lastNudgeSignature: {},
        observedAt: at,
        updatedAt: at,
      },
    ])

    expect(await db.teamPrObservations.where("teamId").equals("team-a").count()).toBe(2)
    expect(await db.teamPrObservations.where("runId").equals("r1").primaryKeys()).toEqual([
      "r1:pr1",
      "r1:pr2",
    ])
    expect(
      await db.teamPrObservations.where("derivedStatus").equals("ci_failed").primaryKeys()
    ).toEqual(["r1:pr1"])
  })

  // v132 — unified portable template definitions/packages/provenance plus
  // device-local bindings and rollback journal.
  it("v132 adds the unified template platform tables and query indexes", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(132)

    expect(db.templateDefinitions.schema.primKey.name).toBe("storageKey")
    expect(db.templateDefinitions.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["id", "domain", "status", "version", "updatedAt", "[id+status]"])
    )
    expect(db.templatePackages.schema.primKey.name).toBe("key")
    expect(db.templateInstances.schema.primKey.name).toBe("id")
    expect(db.templateDeviceBindings.schema.indexes.map((index) => index.name)).toContain(
      "[definitionId+slotId]"
    )
    expect(db.templateMigrationJournal.schema.indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(["domain", "sourceKey", "status", "updatedAt"])
    )
  })

  // v104 — Agent-Team board projection (team-board CQRS). Task rows and the
  // team-meta row share the table; the sync delta cursors on `updatedAt` and
  // the mobile board liveQueries `[teamId+updatedAt]`.
  it("v104 adds the agentTeamBoard table with team/updatedAt/kind indexes", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(104)

    await db.agentTeamBoard.bulkPut([
      {
        id: "task-1",
        kind: "task",
        teamId: "team-a",
        title: "Ship",
        description: "",
        status: "pending",
        priority: "normal",
        dependencies: [],
        tags: [],
        order: 0,
        commentCount: 0,
        comments: [],
        attachmentsCount: 0,
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: "team:team-a",
        kind: "team",
        teamId: "team-a",
        name: "Alpha",
        status: "idle",
        maxConcurrentTeammates: 2,
        teammates: [{ id: "w1", name: "W", role: "teammate", status: "idle" }],
        knowledgeTwinIds: [],
        updatedAt: 150,
      },
    ])

    expect(await db.agentTeamBoard.where("teamId").equals("team-a").count()).toBe(2)
    expect(await db.agentTeamBoard.where("updatedAt").above(120).primaryKeys()).toEqual([
      "team:team-a",
    ])
    expect(await db.agentTeamBoard.where("kind").equals("task").primaryKeys()).toEqual(["task-1"])
    expect(
      await db.agentTeamBoard
        .where("[teamId+updatedAt]")
        .between(["team-a", 0], ["team-a", Infinity])
        .primaryKeys()
    ).toEqual(["task-1", "team:team-a"])
  })

  // v50 — Built-in characters → first-party character pack (ADR-0030
  // Amendment). The legacy `char_builtin_*` Dexie rows must pick up
  // `sourcePluginId`, `sourcePackId`, `clonedFromPackCharacterId`, and
  // `packVersionAtClone` so the new clone-hides-overlay dedupe rule
  // treats them as user clones of the overlay. User customisations
  // (e.g. a tampered systemPrompt) must survive verbatim.
  // v78 — Skills installed from the defunct SkillsMP marketplace lose their
  // provenance fields (canonicalId / marketplaceSkillId) and survive as
  // plain local skills; everything else is untouched.
  it("opens at schema v41 (IM connector complete gap closure)", async () => {
    const db = getDb()
    await db.open()
    // Dexie's `verno` reflects the highest version block registered.
    expect(db.verno).toBeGreaterThanOrEqual(41)
  })

  // v45 — IM connector Lark-first completeness pass. All changes are
  // additive optional columns on `adapterInstances`; verify they
  // round-trip through the declared row type and that pre-v45 rows
  // (without the fields) still read fine.
  it("v45 Lark guardrail fields round-trip on adapterInstances", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(45)
    const now = Date.now()

    // A Lark adapter row carrying every v45 field.
    await db.adapterInstances.put({
      id: "lark-v45",
      type: "lark",
      displayName: "Lark Workspace",
      enabled: true,
      transportMode: "webhook",
      settings: {},
      credentialsRef: {
        keyringService: "com.cognia.platforms",
        accounts: ["lark-v45:appSecret", "lark-v45:verificationToken"],
      },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      atResponseStrategy: "mention_only",
      chatAllowlist: ["oc_team_eng", "oc_team_pm"],
      chatBlocklist: ["oc_spam_chat"],
      lastWhoamiAt: now,
      lastWhoamiResult: {
        botName: "Cognia Bot",
        botAvatar: "https://avatars.feishu.cn/abc.png",
        appId: "cli_v45",
        openId: "ou_bot_open_id",
        tenantKey: "tnt_v45",
        scopes: ["im:message", "bot:info", "im:resource"],
        activateStatus: 2,
      },
      createdAt: now,
      updatedAt: now,
    })
    const row = await db.adapterInstances.get("lark-v45")
    expect(row?.atResponseStrategy).toBe("mention_only")
    expect(row?.chatAllowlist).toEqual(["oc_team_eng", "oc_team_pm"])
    expect(row?.chatBlocklist).toEqual(["oc_spam_chat"])
    expect(row?.lastWhoamiAt).toBe(now)
    expect(row?.lastWhoamiResult?.botName).toBe("Cognia Bot")
    expect(row?.lastWhoamiResult?.tenantKey).toBe("tnt_v45")
    expect(row?.lastWhoamiResult?.scopes).toContain("bot:info")

    // Pre-v45 row (no new fields) still reads back fine — every new
    // column is optional, so absence is the same as "not configured".
    await db.adapterInstances.put({
      id: "lark-pre-v45",
      type: "lark",
      displayName: "Pre-v45 row",
      enabled: false,
      transportMode: "webhook",
      settings: {},
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "manual",
      mediaModelPolicy: "local_extract_only",
      createdAt: now,
      updatedAt: now,
    })
    const legacy = await db.adapterInstances.get("lark-pre-v45")
    expect(legacy?.atResponseStrategy).toBeUndefined()
    expect(legacy?.chatAllowlist).toBeUndefined()
    expect(legacy?.chatBlocklist).toBeUndefined()
    expect(legacy?.lastWhoamiAt).toBeUndefined()
    expect(legacy?.lastWhoamiResult).toBeUndefined()
  })

  // v107 — inbound dispatch rules (W3 multi-bot). Additive optional JSON
  // column on `adapterInstances`; verify the full rule shape round-trips
  // and that pre-v107 rows read back with the field absent.
  it("v107 dispatchRules round-trip on adapterInstances", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(107)
    const now = Date.now()

    await db.adapterInstances.put({
      id: "tg-v107",
      type: "telegram",
      displayName: "Rules bot",
      enabled: true,
      transportMode: "longpoll",
      settings: {},
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      dispatchRules: [
        {
          id: "rule-1",
          enabled: true,
          name: "Bug triage",
          match: {
            keywords: ["bug", "崩溃"],
            pattern: "^\\[urgent\\]",
            senderIds: ["u_ops"],
            channelKinds: ["group", "private"],
          },
          action: { teamId: "team_triage" },
        },
        {
          id: "rule-2",
          match: {},
          action: { characterId: "char_support", workflowId: "wf_escalate" },
        },
      ],
      createdAt: now,
      updatedAt: now,
    })
    const row = await db.adapterInstances.get("tg-v107")
    expect(row?.dispatchRules).toHaveLength(2)
    expect(row?.dispatchRules?.[0]).toEqual({
      id: "rule-1",
      enabled: true,
      name: "Bug triage",
      match: {
        keywords: ["bug", "崩溃"],
        pattern: "^\\[urgent\\]",
        senderIds: ["u_ops"],
        channelKinds: ["group", "private"],
      },
      action: { teamId: "team_triage" },
    })
    expect(row?.dispatchRules?.[1].action.workflowId).toBe("wf_escalate")

    // Pre-v107 row (no dispatchRules) still reads back fine.
    await db.adapterInstances.put({
      id: "tg-pre-v107",
      type: "telegram",
      displayName: "Legacy bot",
      enabled: false,
      transportMode: "longpoll",
      settings: {},
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "manual",
      mediaModelPolicy: "local_extract_only",
      createdAt: now,
      updatedAt: now,
    })
    const legacyRules = await db.adapterInstances.get("tg-pre-v107")
    expect(legacyRules?.dispatchRules).toBeUndefined()
  })

  // v45 — `adapter.heartbeat` AuditKind is accepted by the
  // `connectorAudit` table writer and the index can filter it out.
  it("v45 adapter.heartbeat audit rows round-trip and are filterable by kind", async () => {
    const db = getDb()
    await db.open()
    const now = Date.now()

    await db.connectorAudit.bulkPut([
      { id: "h-1", adapterId: "lark-v45", kind: "adapter.heartbeat", at: now - 60_000 },
      { id: "h-2", adapterId: "lark-v45", kind: "adapter.heartbeat", at: now - 30_000 },
      { id: "h-3", adapterId: "lark-v45", kind: "adapter.started", at: now - 90_000 },
    ])

    const heartbeats = await db.connectorAudit.where("kind").equals("adapter.heartbeat").toArray()
    expect(heartbeats).toHaveLength(2)
    expect(heartbeats.every((r) => r.adapterId === "lark-v45")).toBe(true)

    const nonHeartbeat = await db.connectorAudit.where("kind").equals("adapter.started").toArray()
    expect(nonHeartbeat).toHaveLength(1)
    expect(nonHeartbeat[0].kind).toBe("adapter.started")
  })

  // v51 — the new compound indexes and the dedicated heartbeat table.
  it("v51 outboundQueue [status+nextAttemptAt] index drives a due-job range query", async () => {
    const db = getDb()
    await db.open()
    const now = Date.now()
    await db.outboundQueue.bulkPut([
      makeOutboundRow("due-pending", { status: "pending", nextAttemptAt: now - 1_000 }),
      makeOutboundRow("future-pending", { status: "pending", nextAttemptAt: now + 60_000 }),
      makeOutboundRow("due-failed", { status: "failed", nextAttemptAt: now - 500 }),
      makeOutboundRow("sent", { status: "sent", nextAttemptAt: now - 5_000 }),
    ])

    const duePending = await db.outboundQueue
      .where("[status+nextAttemptAt]")
      .between(["pending", -Infinity], ["pending", now])
      .toArray()
    expect(duePending.map((r) => r.id)).toEqual(["due-pending"])

    const dueFailed = await db.outboundQueue
      .where("[status+nextAttemptAt]")
      .between(["failed", -Infinity], ["failed", now])
      .toArray()
    expect(dueFailed.map((r) => r.id)).toEqual(["due-failed"])
  })

  it("v51 connectorAudit [adapterId+kind+at] index isolates one adapter+kind stream", async () => {
    const db = getDb()
    await db.open()
    const now = Date.now()
    await db.connectorAudit.bulkPut([
      { id: "i-1", adapterId: "lark-v51", kind: "inbound.received", at: now - 10_000 },
      { id: "i-2", adapterId: "lark-v51", kind: "inbound.received", at: now - 5_000 },
      { id: "i-3", adapterId: "lark-v51", kind: "delivery.success", at: now - 1_000 },
      { id: "i-4", adapterId: "other-v51", kind: "inbound.received", at: now - 2_000 },
    ])

    const lastInbound = await db.connectorAudit
      .where("[adapterId+kind+at]")
      .between(
        ["lark-v51", "inbound.received", -Infinity],
        ["lark-v51", "inbound.received", Infinity]
      )
      .last()
    expect(lastInbound?.id).toBe("i-2")
  })

  it("v51 connectorHeartbeats round-trips and prunes by [adapterId+at]", async () => {
    const db = getDb()
    await db.open()
    const now = Date.now()
    await db.connectorHeartbeats.bulkPut([
      { id: "hb-1", adapterId: "lark-v51", kind: "adapter.heartbeat", at: now - 90_000 },
      { id: "hb-2", adapterId: "lark-v51", kind: "adapter.heartbeat", at: now - 1_000 },
      { id: "hb-3", adapterId: "other-v51", kind: "adapter.heartbeat", at: now - 90_000 },
    ])

    await db.connectorHeartbeats
      .where("[adapterId+at]")
      .between(["lark-v51", -Infinity], ["lark-v51", now - 60_000])
      .delete()

    const remaining = await db.connectorHeartbeats.toArray()
    expect(remaining.map((r) => r.id).sort()).toEqual(["hb-2", "hb-3"])
  })

  // v43 — Built-in skills tier + lark-cli bridge (ADR-0026). All changes
  // are additive optional columns; verify they round-trip through the
  // declared row types and that the `kind` widening accepts the new
  // `"skill_invoke"` discriminator.
  it("v43 built-in-skill fields round-trip on the affected tables", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(43)
    const now = Date.now()

    // connectorCallbackBindings: new `"skill_invoke"` kind + payload.
    await db.connectorCallbackBindings.put({
      id: "lark-1:skinv-42",
      adapterId: "lark-1",
      actionId: "skinv-42",
      kind: "skill_invoke",
      surfaceId: "sfc_confirm",
      componentId: "btn_yes",
      conversationKey: "lark:lark-1:oc_x",
      createdAt: now,
      expiresAt: now + 7 * 24 * 3600 * 1000,
      payload: {
        skillId: "lark.calendar.create_event",
        args: { title: "Q4 review", start: "2026-06-01T15:00:00", end: "2026-06-01T16:00:00" },
      },
    })
    const bindings = await db.connectorCallbackBindings
      .where("kind")
      .equals("skill_invoke")
      .toArray()
    expect(bindings).toHaveLength(1)
    expect(bindings[0].payload?.skillId).toBe("lark.calendar.create_event")

    // conversationOverrides: per-channel built-in skill gating.
    await db.conversationOverrides.put({
      id: "co-v43-1",
      conversationKey: "lark:lark-1:oc_y",
      sessionId: "s_v43_1",
      allowedBuiltInSkillIds: ["lark.calendar.list_events", "lark.doc.search"],
      requireHitlForWrites: false,
      createdAt: now,
      updatedAt: now,
    })
    const co = await db.conversationOverrides.get("co-v43-1")
    expect(co?.allowedBuiltInSkillIds).toEqual(["lark.calendar.list_events", "lark.doc.search"])
    expect(co?.requireHitlForWrites).toBe(false)

    // conversationOverrides: "all" sentinel survives the put/get round-trip.
    await db.conversationOverrides.put({
      id: "co-v43-2",
      conversationKey: "lark:lark-1:oc_z",
      sessionId: "s_v43_2",
      allowedBuiltInSkillIds: "all",
      createdAt: now,
      updatedAt: now,
    })
    expect((await db.conversationOverrides.get("co-v43-2"))?.allowedBuiltInSkillIds).toBe("all")

    // adapterInstances: lastKnownSkillCapabilities cache column.
    await db.adapterInstances.put({
      id: "lark-1",
      type: "lark",
      displayName: "Lark Workspace",
      enabled: true,
      transportMode: "webhook",
      settings: {},
      credentialsRef: {
        keyringService: "com.cognia.platforms",
        accounts: ["lark-1:appSecret"],
      },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      lastKnownSkillCapabilities: [
        { family: "lark.calendar", mutations: ["read", "write"] },
        { family: "lark.doc", mutations: ["read", "write", "destructive"] },
        { family: "lark.task", mutations: ["read", "write"] },
      ],
      createdAt: now,
      updatedAt: now,
    })
    const adapter = await db.adapterInstances.get("lark-1")
    expect(adapter?.lastKnownSkillCapabilities).toHaveLength(3)
    expect(adapter?.lastKnownSkillCapabilities?.[0].family).toBe("lark.calendar")
    expect(adapter?.lastKnownSkillCapabilities?.[1].mutations).toContain("destructive")
  })

  // v41 — IM connector complete gap closure (ADR-0009 v41,
  // im-a2ui-warm-eclipse plan). Round-trip the five additive fields so a
  // future contributor can't accidentally trim them in a downstream type
  // refactor.
  it("v41 connector + automation fields round-trip and indexes accept inserts", async () => {
    const db = getDb()
    const now = Date.now()

    // connectorCallbackBindings: new `kind` column + index.
    await db.connectorCallbackBindings.put({
      id: "tg-1:msg-42",
      adapterId: "tg-1",
      actionId: "msg-42",
      kind: "force_reply",
      surfaceId: "sfc_form",
      componentId: "txt_name",
      conversationKey: "telegram:tg-1:1",
      createdAt: now,
    })
    const bindings = await db.connectorCallbackBindings
      .where("kind")
      .equals("force_reply")
      .toArray()
    expect(bindings).toHaveLength(1)
    expect(bindings[0].kind).toBe("force_reply")

    // adapterInstances: new `implMetadata` column.
    await db.adapterInstances.put({
      id: "ob-1",
      type: "onebot",
      displayName: "QQ via NapCat",
      enabled: true,
      transportMode: "reverse-ws",
      settings: {},
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["ob-1:onebotBearer"] },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "manual",
      mediaModelPolicy: "local_extract_only",
      implMetadata: {
        impl: "napcat",
        version: "4.2.1",
        features: ["markdown-card", "upload_group_file", "set_msg_emoji_like"],
      },
      createdAt: now,
      updatedAt: now,
    })
    const ob = await db.adapterInstances.get("ob-1")
    expect(ob?.implMetadata?.impl).toBe("napcat")
    expect(ob?.implMetadata?.features).toContain("markdown-card")

    // conversationOverrides: provider/model override columns.
    await db.conversationOverrides.put({
      id: "co-v41",
      conversationKey: "slack:slk-1:C123",
      sessionId: "s_v41",
      providerOverride: "codex",
      modelOverride: "gpt-5",
      createdAt: now,
      updatedAt: now,
    })
    const co = await db.conversationOverrides.get("co-v41")
    expect(co?.providerOverride).toBe("codex")
    expect(co?.modelOverride).toBe("gpt-5")

    // outboundQueue: source + sourceWorkflow.
    await db.outboundQueue.put({
      id: "ob-v41-wf",
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:1",
      request: {
        conversationRef: { platform: "telegram", adapterId: "tg-1" },
        segments: [{ type: "text", text: "from workflow" }],
        metadata: { idempotencyKey: "k_wf" },
      },
      status: "pending",
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
      idempotencyKey: "k_wf",
      source: "workflow",
      sourceWorkflow: { workflowId: "wf_1", runId: "run_1", nodeId: "n_send" },
    })
    const wfJob = await db.outboundQueue.get("ob-v41-wf")
    expect(wfJob?.source).toBe("workflow")
    expect(wfJob?.sourceWorkflow?.workflowId).toBe("wf_1")

    // automationAuditLog: conversationKey column + index.
    await db.automationAuditLog.put({
      id: "aud-v41-1",
      ts: now,
      surface: "computerUse",
      pluginId: null,
      command: "screen.capture",
      processName: null,
      windowTitle: null,
      decision: "allow",
      reason: null,
      durationMs: 12,
      error: null,
      conversationKey: "discord:dc-1:9999",
    })
    const audits = await db.automationAuditLog
      .where("conversationKey")
      .equals("discord:dc-1:9999")
      .toArray()
    expect(audits).toHaveLength(1)
    expect(audits[0].decision).toBe("allow")
  })

  // §A-Schema migration check for v18: Platform Connectors tables open
  // cleanly on a fresh database (Dexie auto-applies all version blocks up to
  // 18). Verify round-trips through each new table to prove the per-row type
  // compiles and the declared indexes accept inserts.
  it("v18 connector tables accept inserts and reads round-trip", async () => {
    const db = getDb()
    const now = Date.now()

    await db.adapterInstances.put({
      id: "tg-1",
      type: "telegram",
      displayName: "My Telegram bot",
      enabled: true,
      transportMode: "longpoll",
      settings: { pollIntervalMs: 1000 },
      credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["tg-1:botToken"] },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: true,
      },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      createdAt: now,
      updatedAt: now,
    })
    expect((await db.adapterInstances.get("tg-1"))?.type).toBe("telegram")

    await db.platformIdentities.put({
      id: "pi-1",
      platform: "telegram",
      adapterId: "tg-1",
      remoteUserId: "999",
      displayName: "Alice",
      lastSeenAt: now,
    })
    expect(
      (
        await db.platformIdentities
          .where("[platform+remoteUserId]")
          .equals(["telegram", "999"])
          .first()
      )?.id
    ).toBe("pi-1")

    await db.inboundLedger.put({
      id: "tg-1:inbound:m-1",
      adapterId: "tg-1",
      namespace: "inbound",
      platformMessageId: "m-1",
      receivedAt: now,
    })
    expect((await db.inboundLedger.get("tg-1:inbound:m-1"))?.adapterId).toBe("tg-1")

    await db.outboundQueue.put({
      id: "ob-1",
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:1",
      request: {
        conversationRef: { platform: "telegram", adapterId: "tg-1" },
        segments: [{ type: "text", text: "hi" }],
        metadata: { idempotencyKey: "k1" },
      },
      status: "pending",
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
      idempotencyKey: "k1",
      source: "ai-run",
    })
    expect((await db.outboundQueue.get("ob-1"))?.status).toBe("pending")

    await db.conversationOverrides.put({
      id: "co-1",
      conversationKey: "telegram:tg-1:1",
      sessionId: "s1",
      mode: "manual",
      createdAt: now,
      updatedAt: now,
    })
    expect(
      (await db.conversationOverrides.where("conversationKey").equals("telegram:tg-1:1").first())
        ?.mode
    ).toBe("manual")

    await db.connectorAudit.put({
      id: "a-1",
      adapterId: "tg-1",
      kind: "delivery.success",
      at: now,
    })
    expect((await db.connectorAudit.get("a-1"))?.kind).toBe("delivery.success")

    await db.connectorDrafts.put({
      id: "d-1",
      conversationKey: "telegram:tg-1:1",
      sessionId: "s1",
      segments: [{ type: "text", text: "draft" }],
      status: "pending",
      createdAt: now,
    })
    expect((await db.connectorDrafts.get("d-1"))?.status).toBe("pending")

    await db.connectorAttachments.put({
      id: "att-1",
      adapterId: "tg-1",
      remoteRef: "tg-file-id",
      cacheKey: "a".repeat(64),
      mimeType: "image/png",
      sizeBytes: 1024,
      fetchedAt: now,
      lastAccessedAt: now,
    })
    expect((await db.connectorAttachments.get("att-1"))?.mimeType).toBe("image/png")
  })

  // §A-Schema migration check for v17: tables open cleanly on a fresh
  // database (Dexie auto-applies all version blocks up to 17). Verify
  // round-trips through each new table to prove the per-row type compiles
  // and the declared indexes accept inserts.
  it("v17 wiki + audit tables accept inserts and reads round-trip", async () => {
    const db = getDb()
    const now = Date.now()

    await db.wikiArticles.put({
      id: "wka_1",
      corpusId: "cognia-self",
      slug: "lib-foo",
      title: "lib/foo overview",
      module: "lib/foo",
      scope: "cognia-self",
      pageRank: 0.42,
      summary: "summary",
      sectionIds: ["wks_1"],
      sourceRefs: [{ filePath: "lib/foo/index.ts", lineStart: 1, lineEnd: 10, sha: "abc" }],
      contentMd: "# heading\n\nbody",
      embedding: [0.1, 0.2],
      generatedAt: now,
      generatorVersion: "v1",
      fileHashes: { "lib/foo/index.ts": "abc" },
    })

    await db.wikiSections.put({
      id: "wks_1",
      corpusId: "cognia-self",
      articleId: "wka_1",
      sectionIndex: 0,
      headingPath: ["overview"],
      bodyMd: "section",
      sourceRefs: [],
    })

    await db.wikiManifest.put({
      scope: "cognia-self",
      fileHashes: { "lib/foo/index.ts": "abc" },
      lastBuildAt: now,
      articleCount: 1,
      generatorVersion: "v1",
    })

    await db.mcpAuditLog.put({
      id: "mau_1",
      ts: now,
      tool: "wiki_search",
      scope: "wiki:cognia",
      allowed: true,
      latencyMs: 5,
    })

    expect(await db.wikiArticles.get("wka_1")).toMatchObject({ slug: "lib-foo" })
    expect(await db.wikiSections.get("wks_1")).toMatchObject({ articleId: "wka_1" })
    expect(await db.wikiManifest.get("cognia-self")).toMatchObject({ articleCount: 1 })
    expect(await db.mcpAuditLog.get("mau_1")).toMatchObject({ tool: "wiki_search" })

    // Composite index on `wikiArticles[scope+module]` drives the wiki_search
    // module-filter path — verify the composite key returns the row.
    const byModule = await db.wikiArticles
      .where(["scope", "module"])
      .equals(["cognia-self", "lib/foo"])
      .toArray()
    expect(byModule).toHaveLength(1)
  })

  // §A-Schema migration check: Dexie auto-applies all version blocks up to
  // the latest when the schema bumps. Verify v15 opens cleanly on a fresh
  // database and that we can write/read a row through each new table — that
  // proves both the index declarations and the per-row type compile.
  it("v15 plugin tables accept inserts and reads round-trip", async () => {
    const db = getDb()
    const now = Date.now()

    await db.plugins.put({
      id: "p1",
      name: "Test Plugin",
      version: "1.0.0",
      status: "enabled",
      source: "builtin",
      type: "frontend",
      enabled: true,
      capabilities: ["tools", "commands"],
      path: "<builtin>/p1",
      manifest: { id: "p1", name: "Test Plugin", version: "1.0.0" },
      createdAt: now,
      updatedAt: now,
    })

    await db.pluginPermissions.put({
      pluginId: "p1",
      permission: "shell:execute",
      decision: "allow",
      grantedAt: now,
    })

    await db.pluginReviews.put({
      id: "rev-1",
      pluginId: "p1",
      rating: 5,
      title: "Great",
      createdAt: now,
    })

    await db.pluginAnalytics.put({
      pluginId: "p1",
      key: "tool.git_status.invocations",
      count: 7,
      lastEventAt: now,
    })

    expect(await db.plugins.get("p1")).toMatchObject({ name: "Test Plugin", enabled: true })
    expect(await db.pluginPermissions.get(["p1", "shell:execute"])).toMatchObject({
      decision: "allow",
    })
    expect(await db.pluginReviews.get(["p1", "rev-1"])).toMatchObject({ rating: 5 })
    expect(await db.pluginAnalytics.get(["p1", "tool.git_status.invocations"])).toMatchObject({
      count: 7,
    })
  })

  it("v15 plugin indexes drive filtered queries (multi-entry capabilities)", async () => {
    const db = getDb()
    const now = Date.now()
    await db.plugins.bulkPut([
      {
        id: "a",
        name: "A",
        version: "1",
        status: "enabled",
        source: "builtin",
        type: "frontend",
        enabled: true,
        capabilities: ["tools", "commands"],
        path: "x",
        manifest: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "b",
        name: "B",
        version: "1",
        status: "enabled",
        source: "builtin",
        type: "frontend",
        enabled: true,
        capabilities: ["modes", "themes"],
        path: "x",
        manifest: {},
        createdAt: now,
        updatedAt: now,
      },
    ])

    // The `*capabilities` multi-entry index supports `where("capabilities").equals(...)`
    // queries — exactly the lookup the Settings → Plugins capability filter uses.
    const toolsPlugins = await db.plugins.where("capabilities").equals("tools").toArray()
    expect(toolsPlugins.map((p) => p.id)).toEqual(["a"])
    const themesPlugins = await db.plugins.where("capabilities").equals("themes").toArray()
    expect(themesPlugins.map((p) => p.id)).toEqual(["b"])
  })

  it("returns the same instance on repeat calls (memoised)", () => {
    const a = getDb()
    const b = getDb()
    expect(a).toBe(b)
  })

  it("__resetDbForTesting drops the cached instance", () => {
    const a = getDb()
    __resetDbForTesting()
    const b = getDb()
    expect(a).not.toBe(b)
  })

  // SSR guard (`typeof window === "undefined"`) cannot be exercised under
  // jsdom — `window` is a non-configurable global and `typeof` resolves
  // against the binding regardless of `globalThis.window`. The branch is
  // covered indirectly by every other test calling `getDb()` and observing
  // the "happy path" return value: the false branch of that conditional is
  // hit in every spec. Documenting here so a future maintainer knows why
  // we don't claim to exercise the throw.
})

describe("cross-context upgrade yield channel", () => {
  /**
   * jsdom has no BroadcastChannel — stub one that records instances, posted
   * messages, and lets tests deliver inbound messages via `onmessage`.
   */
  class FakeBroadcastChannel {
    static instances: FakeBroadcastChannel[] = []
    onmessage: ((ev: { data: unknown }) => void) | null = null
    posted: unknown[] = []
    closed = false
    constructor(public name: string) {
      FakeBroadcastChannel.instances.push(this)
    }
    postMessage(data: unknown): void {
      this.posted.push(data)
    }
    close(): void {
      this.closed = true
    }
  }

  let infoSpy: jest.SpyInstance
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    FakeBroadcastChannel.instances = []
    ;(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel
    ;(emit as jest.Mock).mockClear()
    ;(listen as jest.Mock).mockClear()
    __resetDbForTesting()
    // Dexie's constructor-registered blocked subscriber console.warns; ours
    // console.infos. Silence both to keep test output clean.
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {})
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    __resetDbForTesting()
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel
    // Restore the default (web) detection so later suites aren't left in Tauri
    // mode by a test that opted in.
    ;(isTauri as jest.Mock).mockReturnValue(false)
    infoSpy.mockRestore()
    warnSpy.mockRestore()
  })

  /** Flush the microtask + macrotask queue so lazy `import()`s settle. */
  const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

  function activeChannel(): FakeBroadcastChannel {
    const open = FakeBroadcastChannel.instances.filter((c) => !c.closed)
    expect(open).toHaveLength(1)
    return open[0]
  }

  it("creates the coordination channel lazily on getDb()", () => {
    expect(FakeBroadcastChannel.instances).toHaveLength(0)
    getDb()
    expect(activeChannel().name).toBe("cognia-db-yield")
  })

  it("unrefs the channel on hosts that support it, so the process can still exit", () => {
    // Node's BroadcastChannel keeps the event loop alive by itself: without
    // this, `cognia-agent run` finishes its turn and then hangs forever. The
    // shared fake deliberately has NO `unref` (that is the browser shape every
    // other test in this block covers), so only this subclass sees the call.
    const unref = jest.fn()
    class UnrefableChannel extends FakeBroadcastChannel {
      unref = unref
    }
    ;(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = UnrefableChannel

    getDb()

    expect(unref).toHaveBeenCalledTimes(1)
    // Unref must not close the channel — the handshake still has to deliver.
    expect(activeChannel().closed).toBe(false)
  })

  it("broadcasts a yield request when our upgrade is blocked", () => {
    const db = getDb()
    db.on("blocked").fire({ oldVersion: 1220, newVersion: 1230 })
    expect(activeChannel().posted).toEqual([
      { type: "dexie-yield", dbName: db.name, origin: expect.any(String) },
    ])
    expect(infoSpy).toHaveBeenCalled()
  })

  it("closes the cached connection when another context asks us to yield", () => {
    const before = getDb()
    activeChannel().onmessage?.({ data: { type: "dexie-yield", dbName: before.name } })
    const after = getDb()
    expect(after).not.toBe(before)
  })

  it("reports the holding module before yielding and records remote owner reports", async () => {
    const before = getDb()
    await before.open()
    const channel = activeChannel()
    channel.onmessage?.({
      data: { type: "dexie-yield", dbName: before.name, origin: "requester" },
    })
    expect(channel.posted).toContainEqual({
      type: "dexie-yield-owners",
      dbName: before.name,
      origin: expect.any(String),
      targetOrigin: "requester",
      connectionOwners: ["active-singleton"],
    })

    const requester = getDb()
    requester.on("blocked").fire({ oldVersion: 1, newVersion: 2 })
    const request = channel.posted.find(
      (message) => (message as { type?: string }).type === "dexie-yield"
    ) as { origin: string }
    channel.onmessage?.({
      data: {
        type: "dexie-yield-owners",
        dbName: before.name,
        origin: "holder",
        targetOrigin: request.origin,
        connectionOwners: ["pet-overlay"],
      },
    })
    expect(getDatabaseUpgradeBlockerOwners(before.name)).toEqual(["pet-overlay"])
  })

  it("ignores yield requests for a different database name", () => {
    const before = getDb()
    const channel = activeChannel()
    channel.onmessage?.({ data: { type: "dexie-yield", dbName: "cognia-account-other" } })
    channel.onmessage?.({ data: { type: "something-else", dbName: before.name } })
    channel.onmessage?.({ data: undefined })
    expect(getDb()).toBe(before)
  })

  it("__resetDbForTesting closes the channel", () => {
    getDb()
    const channel = activeChannel()
    __resetDbForTesting()
    expect(channel.closed).toBe(true)
  })

  it("degrades gracefully when BroadcastChannel is unavailable", () => {
    delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel
    const db = getDb()
    // Firing blocked must not throw even though no channel could be created.
    expect(() => db.on("blocked").fire({ oldVersion: 1220, newVersion: 1230 })).not.toThrow()
    expect(FakeBroadcastChannel.instances).toHaveLength(0)
  })

  // BroadcastChannel does not cross separate WKWebView windows, so on Tauri the
  // handshake also rides the Tauri event bus — the only channel that reaches the
  // pet / fleet-island overlay webviews holding the base schema version.
  it("does not touch the Tauri event bus off Tauri", () => {
    const db = getDb()
    db.on("blocked").fire({ oldVersion: 1220, newVersion: 1230 })
    expect(emit).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
  })

  it("mirrors the yield request onto the Tauri event bus when blocked in Tauri", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(true)
    const db = getDb()
    db.on("blocked").fire({ oldVersion: 1220, newVersion: 1230 })
    await flushAsync()
    expect(emit).toHaveBeenCalledWith("cognia://db-yield", {
      type: "dexie-yield",
      dbName: db.name,
      origin: expect.any(String),
    })
  })

  it("closes the cached connection on a foreign-origin Tauri yield event", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(true)
    const before = getDb()
    await flushAsync() // let the lazy listen() registration settle
    const handler = (listen as jest.Mock).mock.calls.at(-1)?.[1] as (ev: {
      payload: { type: string; dbName: string; origin: string }
    }) => void
    handler({ payload: { type: "dexie-yield", dbName: before.name, origin: "other-window" } })
    expect(getDb()).not.toBe(before)
  })

  it("ignores a Tauri yield event it emitted itself", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(true)
    const before = getDb()
    before.on("blocked").fire({ oldVersion: 1, newVersion: 2 })
    await flushAsync()
    const ownOrigin = (emit as jest.Mock).mock.calls.at(-1)?.[1]?.origin as string
    const handler = (listen as jest.Mock).mock.calls.at(-1)?.[1] as (ev: {
      payload: { type: string; dbName: string; origin: string }
    }) => void
    handler({ payload: { type: "dexie-yield", dbName: before.name, origin: ownOrigin } })
    // Same instance — the upgrading window must never yank its own connection.
    expect(getDb()).toBe(before)
  })

  it("ignores a Tauri yield event for a different database name", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(true)
    const before = getDb()
    await flushAsync()
    const handler = (listen as jest.Mock).mock.calls.at(-1)?.[1] as (ev: {
      payload: { type: string; dbName: string; origin: string }
    }) => void
    handler({ payload: { type: "dexie-yield", dbName: "cognia-account-other", origin: "x" } })
    handler({ payload: { type: "not-a-yield", dbName: before.name, origin: "x" } })
    expect(getDb()).toBe(before)
  })
})

describe("whenSeeded", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("resolves once and reflects seeded built-in characters", async () => {
    getDb()
    await whenSeeded()
    const built = await getDb().characters.where("isBuiltIn").equals(1).count()
    // Boolean indexing is unreliable across IDB shims; fall back to filter.
    const all = await getDb().characters.toArray()
    const builtIns = all.filter((c) => c.isBuiltIn)
    expect(builtIns.length + built).toBeGreaterThan(0)
  })

  it("returns a resolved promise when no seed run is pending", async () => {
    // Without calling getDb first, _seedPromise is null — whenSeeded must
    // gracefully kick off a seed via getDb(), then resolve.
    await expect(whenSeeded()).resolves.toBeUndefined()
  })
})

describe("schema upgrade hooks (round-trip via the latest version)", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("opens at v12 with the documented promptPresets indexes", async () => {
    const db = getDb()
    // Verify the table is queryable by the new boolean-ish indexes added in v12.
    await db.promptPresets.put({
      id: "p_test",
      name: "T",
      content: "x",
      isBuiltIn: false,
      isFavorite: true,
      sortOrder: 5,
      usageCount: 0,
      createdAt: 0,
      updatedAt: 0,
    })
    const fetched = await db.promptPresets.get("p_test")
    expect(fetched?.isFavorite).toBe(true)
    // Index on sortOrder is queryable
    const ordered = await db.promptPresets.orderBy("sortOrder").toArray()
    expect(ordered.find((p) => p.id === "p_test")?.sortOrder).toBe(5)
  })

  it("seed catch handler swallows DatabaseClosedError silently", async () => {
    // Trigger the .catch(...) branch in getDb's seed kickoff. We do this by
    // racing a db.delete() against the inflight seed; Dexie throws
    // DatabaseClosedError which the schema's catch handler short-circuits.
    const db = getDb()
    const seedDeletePromise = db.delete()
    // Wait for the seed promise to settle (the catch should fire).
    await whenSeeded()
    await seedDeletePromise
    // No assertion needed beyond "did not reject" — test passes if we got
    // here without an unhandled rejection.
    expect(true).toBe(true)
  })

  it("seed readiness logs and surfaces unrelated errors", async () => {
    // Force the inner seed to reject with a non-DatabaseClosed error so we
    // hit the `console.error` branch. We achieve this by mocking
    // `seedBuiltIns` via jest.doMock with a fresh module load.
    await jest.isolateModulesAsync(async () => {
      jest.doMock("./seed", () => ({
        seedBuiltIns: () => Promise.reject(new Error("boom")),
      }))
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
      const fresh = await import("./schema")
      fresh.__resetDbForTesting()
      fresh.getDb()
      await expect(fresh.whenSeeded()).rejects.toThrow("boom")
      expect(errSpy).toHaveBeenCalledWith("seedBuiltIns failed", expect.any(Error))
      errSpy.mockRestore()
      fresh.__resetDbForTesting()
    })
    jest.dontMock("./seed")
  })

  it("reopens and retries once when a schema mutation invalidates the seed transaction", async () => {
    await jest.isolateModulesAsync(async () => {
      const transactionInactive = Object.assign(new Error("transaction ended"), {
        name: "TransactionInactiveError",
      })
      const seedBuiltIns = jest
        .fn<Promise<void>, []>()
        .mockRejectedValueOnce(transactionInactive)
        .mockResolvedValueOnce(undefined)
      jest.doMock("./seed", () => ({
        seedBuiltIns,
      }))
      const fresh = await import("./schema")
      fresh.__resetDbForTesting()

      await expect(fresh.whenSeeded()).resolves.toBeUndefined()

      expect(seedBuiltIns).toHaveBeenCalledTimes(2)
      fresh.__resetDbForTesting()
    })
    jest.dontMock("./seed")
  })

  it("v68 notifications table exposes the dedupeKey/groupKey + compound indexes", async () => {
    const db = getDb()
    await db.open()
    const base = {
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      count: 1,
      directed: false,
      deliveredVia: ["center"] as const,
    }
    await db.notifications.bulkPut([
      {
        id: "x",
        source: "connector",
        level: "info",
        readState: "unseen",
        dedupeKey: "k",
        groupKey: "g",
        ...base,
      },
      {
        id: "y",
        source: "scheduler",
        level: "error",
        readState: "read",
        ...base,
        createdAt: 2,
        updatedAt: 2,
      },
    ] as never)
    // Single-property indexes are queryable.
    expect((await db.notifications.where("dedupeKey").equals("k").toArray())[0]?.id).toBe("x")
    expect((await db.notifications.where("groupKey").equals("g").toArray())[0]?.id).toBe("x")
    // Compound [readState+createdAt] index is usable (newest-unread feed).
    const unseen = await db.notifications
      .where("[readState+createdAt]")
      .between(["unseen", -Infinity], ["unseen", Infinity])
      .toArray()
    expect(unseen.map((r) => r.id)).toEqual(["x"])
    // Compound [source+createdAt] index is usable (per-source feed).
    const sched = await db.notifications
      .where("[source+createdAt]")
      .between(["scheduler", -Infinity], ["scheduler", Infinity])
      .toArray()
    expect(sched.map((r) => r.id)).toEqual(["y"])
  })
})

describe("v79 loop tables (/loop command)", () => {
  it("registers loops + loopEvents with their indexes", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(79)
    await db.loops.add({
      id: "lp_1",
      sessionId: "ses_a",
      mode: "interval",
      rawPrompt: "check deploy",
      safePrompt: "check deploy",
      redactionMapEnc: "",
      isSlashCommand: false,
      status: "active",
      iterations: 0,
      tokensUsed: 0,
      generationId: "gen-1",
      config: {
        maxIterations: 100,
        maxTokens: 1_000_000,
        minDelayMs: 60_000,
        maxDelayMs: 3_600_000,
        maxParseFailures: 3,
      },
      parseFailureCount: 0,
      scheduledTaskId: "task_1",
      createdAt: 1,
      updatedAt: 1,
    })
    await db.loopEvents.add({
      id: "lev_1",
      loopId: "lp_1",
      kind: "loop_created",
      ts: 1,
      payload: {
        kind: "loop_created",
        mode: "interval",
        safePrompt: "check deploy",
        config: {
          maxIterations: 100,
          maxTokens: 1_000_000,
          minDelayMs: 60_000,
          maxDelayMs: 3_600_000,
          maxParseFailures: 3,
        },
      },
    })
    // Compound [sessionId+status] serves the one-active-per-session lookup.
    const active = await db.loops.where("[sessionId+status]").equals(["ses_a", "active"]).first()
    expect(active?.id).toBe("lp_1")
    // scheduledTaskId is indexed for scheduler-side reverse lookups.
    expect((await db.loops.where("scheduledTaskId").equals("task_1").first())?.id).toBe("lp_1")
    // [loopId+ts] serves the reverse-chrono activity feed.
    const events = await db.loopEvents
      .where("[loopId+ts]")
      .between(["lp_1", -Infinity], ["lp_1", Infinity])
      .toArray()
    expect(events).toHaveLength(1)
  })
})

describe("v80 chatInputHistory (composer ↑/↓ recall)", () => {
  it("registers chatInputHistory with auto-increment id + [sessionId+createdAt]", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(80)
    const id = await db.chatInputHistory.add({ sessionId: "ses_h", text: "hello", createdAt: 1 })
    expect(typeof id).toBe("number")
    await db.chatInputHistory.add({ sessionId: "ses_h", text: "world", createdAt: 2 })
    const rows = await db.chatInputHistory
      .where("[sessionId+createdAt]")
      .between(["ses_h", -Infinity], ["ses_h", Infinity])
      .toArray()
    expect(rows.map((r) => r.text)).toEqual(["hello", "world"])
  })
})

describe("v81 conversation-branching lineage (parentSessionId index)", () => {
  it("indexes sessions.parentSessionId so children resolve by parent", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(81)
    const now = Date.now()
    await db.sessions.put({ id: "ses_parent", title: "Parent", createdAt: now, updatedAt: now })
    await db.sessions.put({
      id: "ses_child",
      title: "Parent (branch)",
      parentSessionId: "ses_parent",
      branchedFromMessageId: "m_3",
      branchKind: "summary",
      branchSeed: { kind: "summary", content: "summary text" },
      createdAt: now,
      updatedAt: now,
    })
    const children = await db.sessions.where("parentSessionId").equals("ses_parent").toArray()
    expect(children.map((s) => s.id)).toEqual(["ses_child"])
    expect(children[0]?.branchSeed).toEqual({ kind: "summary", content: "summary text" })
    // Legacy rows without the field are simply absent from the index.
    const orphans = await db.sessions.where("parentSessionId").equals("ses_parent_missing").count()
    expect(orphans).toBe(0)
  })
})

describe("v89 runRecords (Run Panel second clock)", () => {
  it("registers runRecords with a [sessionId+runId] key and startedAt ordering", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(89)
    await db.runRecords.put({
      sessionId: "ses_r",
      runId: 1,
      startedAt: 100,
      status: "done",
      tools: [],
      subagents: [],
      todos: [],
      todoCounts: { done: 0, total: 0 },
      counts: { tools: 0, subagents: 0 },
    })
    await db.runRecords.put({
      sessionId: "ses_r",
      runId: 2,
      startedAt: 300,
      status: "running",
      tools: [{ id: "t1", toolName: "Bash", status: "output-available" }],
      subagents: [],
      todos: [],
      todoCounts: { done: 0, total: 0 },
      counts: { tools: 1, subagents: 0 },
    })
    const rows = await db.runRecords
      .where("[sessionId+startedAt]")
      .between(["ses_r", -Infinity], ["ses_r", Infinity])
      .toArray()
    expect(rows.map((r) => r.runId)).toEqual([1, 2])
    // The compound key uniquely identifies a run.
    const r1 = await db.runRecords.get(["ses_r", 1])
    expect(r1?.status).toBe("done")
  })
})

describe("v90 sessionFolders (conversation folders)", () => {
  it("registers sessionFolders with a [projectId+order] ordering index", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(90)
    await db.sessionFolders.put({
      id: "f1",
      projectId: "proj_a",
      name: "Work",
      order: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    await db.sessionFolders.put({
      id: "f2",
      projectId: "proj_a",
      name: "Personal",
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await db.sessionFolders.put({
      id: "f3",
      projectId: "proj_b",
      name: "Other workspace",
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const scoped = await db.sessionFolders
      .where("[projectId+order]")
      .between(["proj_a", -Infinity], ["proj_a", Infinity])
      .toArray()
    // Ordered by `order`, scoped to the workspace.
    expect(scoped.map((f) => f.id)).toEqual(["f2", "f1"])
  })
})

describe("v94 petInventory (pet economy)", () => {
  it("round-trips inventory rows keyed by catalog item id", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(94)
    await db.petInventory.put({ id: "berry", qty: 3, acquiredAt: 100, updatedAt: 200 })
    await db.petInventory.put({ id: "yarn-ball", qty: 1, acquiredAt: 150, updatedAt: 150 })
    expect(await db.petInventory.count()).toBe(2)
    expect((await db.petInventory.get("berry"))?.qty).toBe(3)
    // PK upsert semantics — same id replaces, never duplicates.
    await db.petInventory.put({ id: "berry", qty: 4, acquiredAt: 100, updatedAt: 300 })
    expect(await db.petInventory.count()).toBe(2)
    expect((await db.petInventory.get("berry"))?.qty).toBe(4)
  })
})

describe("v106 instance-level AI binding defaults (multi-bot connectors W1/W2)", () => {
  it("round-trips adapter binding defaults and the teamDisabled sentinel", async () => {
    const db = getDb()
    await whenSeeded()
    expect(db.verno).toBeGreaterThanOrEqual(106)
    const now = Date.now()

    await db.adapterInstances.put({
      id: "lark-v106",
      type: "lark",
      displayName: "Lark Bot A",
      enabled: true,
      transportMode: "webhook",
      settings: {},
      credentialsRef: {
        keyringService: "com.cognia.platforms",
        accounts: ["lark-v106:appSecret"],
      },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      defaultTeamId: "team_alpha",
      defaultModel: "claude-fable-5",
      defaultProvider: "anthropic",
      defaultReasoning: "high",
      lastMissingScopes: ["im:chat:create"],
      createdAt: now,
      updatedAt: now,
    })
    const row = await db.adapterInstances.get("lark-v106")
    expect(row?.defaultTeamId).toBe("team_alpha")
    expect(row?.defaultModel).toBe("claude-fable-5")
    expect(row?.defaultProvider).toBe("anthropic")
    expect(row?.defaultReasoning).toBe("high")
    expect(row?.lastMissingScopes).toEqual(["im:chat:create"])

    await db.conversationOverrides.put({
      id: "co-v106",
      conversationKey: "lark:lark-v106:oc_v106",
      sessionId: "s_v106",
      teamDisabled: true,
      createdAt: now,
      updatedAt: now,
    })
    expect((await db.conversationOverrides.get("co-v106"))?.teamDisabled).toBe(true)

    await db.outboundQueue.put({
      id: "job-v106",
      adapterId: "lark-v106",
      conversationKey: "lark:lark-v106:oc_v106",
      request: {
        conversationRef: { platform: "lark", adapterId: "lark-v106", channelId: "oc_v106" },
        segments: [{ type: "text", text: "hello" }],
        metadata: { idempotencyKey: "idem-v106" },
      },
      source: "skill",
      status: "pending",
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
      idempotencyKey: "idem-v106",
    })
    expect((await db.outboundQueue.get("job-v106"))?.source).toBe("skill")
  })
})

describe("schema seed error handling isolation", () => {
  it("logs non-Error rejection values", async () => {
    jest.resetModules()
    await jest.isolateModulesAsync(async () => {
      jest.doMock("./seed", () => ({
        seedBuiltIns: () => Promise.reject("plain failure"),
      }))
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
      const fresh = await import("./schema")
      fresh.__resetDbForTesting()
      fresh.getDb()
      await expect(fresh.whenSeeded()).rejects.toBe("plain failure")
      expect(errSpy).toHaveBeenCalledWith("seedBuiltIns failed", "plain failure")
      errSpy.mockRestore()
      fresh.__resetDbForTesting()
    })
    jest.dontMock("./seed")
    jest.resetModules()
  })
})

// The `blocked` recovery cadence for a schema upgrade that a stale overlay
// connection is holding open. Exercised in isolation from a real IndexedDB
// block: fake timers drive the interval; the getDb glue that starts/stops it is
// thin.
describe("withDbReopenRetry", () => {
  /** Dexie's rejection when the connection goes away under an in-flight op. */
  function closedError(name = "DatabaseClosedError"): Error {
    const err = new Error(
      "Failed to execute 'get' on 'IDBObjectStore': The transaction is inactive or finished."
    )
    err.name = name
    return err
  }

  it("passes the value through when nothing closed the connection", async () => {
    const op = jest.fn(() => Promise.resolve("row"))
    await expect(withDbReopenRetry(op, [0])).resolves.toBe("row")
    expect(op).toHaveBeenCalledTimes(1)
  })

  it("re-issues the operation after the connection is closed under it", async () => {
    const op = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(closedError())
      .mockResolvedValueOnce("row")
    await expect(withDbReopenRetry(op, [0])).resolves.toBe("row")
    expect(op).toHaveBeenCalledTimes(2)
  })

  it("also matches Dexie's shorter spelling of the same error", async () => {
    const op = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(closedError("DatabaseClosed"))
      .mockResolvedValueOnce("row")
    await expect(withDbReopenRetry(op, [0])).resolves.toBe("row")
    expect(op).toHaveBeenCalledTimes(2)
  })

  it("retries the direct TransactionInactiveError emitted by an interrupted transaction", async () => {
    const op = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(closedError("TransactionInactiveError"))
      .mockResolvedValueOnce("row")
    await expect(withDbReopenRetry(op, [0])).resolves.toBe("row")
    expect(op).toHaveBeenCalledTimes(2)
  })

  it("retries Dexie's PrematureCommitError after a schema-close race", async () => {
    const op = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(closedError("PrematureCommitError"))
      .mockResolvedValueOnce("row")
    await expect(withDbReopenRetry(op, [0])).resolves.toBe("row")
    expect(op).toHaveBeenCalledTimes(2)
  })

  it("never retries an error that isn't a closed connection", async () => {
    const boom = new Error("constraint violated")
    boom.name = "ConstraintError"
    const op = jest.fn<Promise<string>, []>().mockRejectedValue(boom)
    await expect(withDbReopenRetry(op, [0, 0])).rejects.toThrow("constraint violated")
    expect(op).toHaveBeenCalledTimes(1)
  })

  it("gives up once the backoff is exhausted, surfacing the last rejection", async () => {
    const op = jest.fn<Promise<string>, []>().mockRejectedValue(closedError())
    await expect(withDbReopenRetry(op, [0, 0])).rejects.toThrow(/transaction is inactive/)
    // One attempt per delay, plus the initial one.
    expect(op).toHaveBeenCalledTimes(3)
  })

  it("backs off on its own schedule when the caller supplies none", async () => {
    const op = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(closedError())
      .mockResolvedValueOnce("row")
    const started = Date.now()
    await expect(withDbReopenRetry(op)).resolves.toBe("row")
    // Default first backoff is 50ms — the retry must not be a hot loop, or it
    // burns every attempt inside the close→open window it is waiting out.
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
  })
})

describe("startBlockedYieldRetry", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
  })

  it("re-nudges on an interval while the open stays blocked", () => {
    const nudge = jest.fn()
    startBlockedYieldRetry(nudge, { intervalMs: 100, maxAttempts: 20 })
    expect(nudge).not.toHaveBeenCalled() // no immediate nudge; the caller sent the first
    jest.advanceTimersByTime(100)
    expect(nudge).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(250)
    expect(nudge).toHaveBeenCalledTimes(3)
  })

  it("stops nudging once the returned handle is called (open became ready)", () => {
    const nudge = jest.fn()
    const stop = startBlockedYieldRetry(nudge, { intervalMs: 100, maxAttempts: 20 })
    jest.advanceTimersByTime(100)
    expect(nudge).toHaveBeenCalledTimes(1)
    stop()
    jest.advanceTimersByTime(1000)
    expect(nudge).toHaveBeenCalledTimes(1)
  })

  it("uses the default interval and cap when no options are supplied", () => {
    const nudge = jest.fn()
    startBlockedYieldRetry(nudge)
    jest.advanceTimersByTime(749)
    expect(nudge).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1) // 750ms — the default interval
    expect(nudge).toHaveBeenCalledTimes(1)
    // Default cap is 20 nudges; the 21st tick gives up and stops.
    jest.advanceTimersByTime(750 * 25)
    expect(nudge).toHaveBeenCalledTimes(20)
  })

  it("gives up after the cap, firing onGiveUp once and nudging no further", () => {
    const nudge = jest.fn()
    const onGiveUp = jest.fn()
    startBlockedYieldRetry(nudge, { intervalMs: 100, maxAttempts: 3, onGiveUp })
    jest.advanceTimersByTime(300)
    expect(nudge).toHaveBeenCalledTimes(3)
    expect(onGiveUp).not.toHaveBeenCalled()
    // The 4th tick exceeds the cap: give up, no further nudge.
    jest.advanceTimersByTime(100)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenCalledTimes(3)
    jest.advanceTimersByTime(500)
    expect(nudge).toHaveBeenCalledTimes(3)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })
})
