/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import Dexie from "dexie"

import { CogniaAccountRegistryDB, LocalAccountRegistry, accountDatabaseName } from "./account-db"
import { legacyDatabaseExists, migrateLegacyDatabaseToAccount } from "./legacy-migration"
import { CogniaDB, LEGACY_COGNIA_DB_NAME } from "@/lib/db/schema"
import type { PasswordVerifierRecord } from "./account-types"

// This suite seeds a v86 database and opens CogniaDB over it to exercise the
// migration — opt out of the Jest collapsed-schema fast path.
;(globalThis as { __COGNIA_DB_FULL_SCHEMA__?: boolean }).__COGNIA_DB_FULL_SCHEMA__ = true

const verifier: PasswordVerifierRecord = {
  algorithm: "test-only",
  salt: "salt",
  hash: "hash",
  params: { iterations: 1 },
}

async function createRegistry(testName: string) {
  const dbName = `cognia-account-registry-${testName}`
  const cleanup = new CogniaAccountRegistryDB(dbName)
  await cleanup.delete()
  const db = new CogniaAccountRegistryDB(dbName)
  const registry = new LocalAccountRegistry(db)
  await registry.createAccount({
    id: "acct_legacy",
    displayName: "Legacy",
    passwordVerifier: verifier,
    now: 1,
  })
  await registry.createAccount({
    id: "acct_second",
    displayName: "Second",
    passwordVerifier: verifier,
    activate: false,
    now: 2,
  })
  return { db, registry }
}

async function deleteCogniaDb(name: string) {
  const db = new CogniaDB(name)
  await db.delete()
}

async function seedLegacyV86(dbName: string) {
  const legacy = new Dexie(dbName)
  legacy.version(86).stores({
    settings: "id",
    projects: "&id, lastAccessedAt",
    sessions:
      "id, updatedAt, createdAt, kind, characterId, teamId, parentSessionId, platformConversationKey, projectId, [projectId+updatedAt]",
    messages:
      "id, sessionId, [sessionId+createdAt], senderId, platformMessageId, [createdAt+id], projectId, [projectId+createdAt]",
    adapterInstances: "id, type, enabled, displayName, [type+enabled], createdAt, updatedAt",
    conversationOverrides:
      "&id, &conversationKey, sessionId, pinned, archived, updatedAt, status, [status+updatedAt], *labelIds, nextResponseDueAt, assigneeKind, projectId",
    sharedLinks: "&id, &code, kind, createdAt, expiresAt",
    pairedDevices: "&deviceId, lastSeenAt, revokedAt, platform",
    syncCursors: "&table, lastSyncAt, since",
  })
  await legacy.open()
  await legacy.table("settings").put({
    id: "singleton",
    activeProjectId: "proj-A",
    updatedAt: 10,
  })
  await legacy.table("projects").put({
    id: "proj-A",
    name: "Workspace A",
    roots: [],
    knowledgeBase: [],
    sessionIds: ["s1"],
    sessionCount: 1,
    messageCount: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastAccessedAt: new Date(0),
  })
  await legacy.table("sessions").put({
    id: "s1",
    title: "Legacy session",
    kind: "direct",
    projectId: "proj-A",
    createdAt: 11,
    updatedAt: 12,
  })
  await legacy.table("messages").put({
    id: "m1",
    sessionId: "s1",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
    projectId: "proj-A",
    createdAt: 13,
  })
  await legacy.table("adapterInstances").put({
    id: "adapter-1",
    type: "telegram",
    enabled: true,
    displayName: "Telegram",
    settings: {},
    createdAt: 14,
    updatedAt: 15,
  })
  await legacy.table("conversationOverrides").put({
    id: "ov1",
    conversationKey: "telegram:adapter-1:chat-1",
    sessionId: "s1",
    pinned: true,
    archived: false,
    updatedAt: 16,
    status: "open",
    labelIds: ["vip"],
    projectId: "proj-A",
  })
  await legacy.table("sharedLinks").put({
    id: "share-1",
    code: "abc123",
    kind: "chat",
    title: "Shared chat",
    url: "https://share.example/#key",
    createdAt: 17,
    burnAfterRead: false,
    hasPassphrase: false,
    ownerToken: "owner-token",
    revoked: false,
  })
  await legacy.table("pairedDevices").put({
    deviceId: "device-1",
    label: "Phone",
    platform: "ios",
    pubkey: "pub",
    pairedAt: 18,
    lastSeenAt: 19,
    appVersion: "1.0.0",
  })
  // Seeded on purpose: v130 drops this table, and the migration must simply
  // not carry it rather than fail on a table the target schema no longer has.
  await legacy.table("syncCursors").put({
    table: "messages",
    since: 20,
    lastSyncAt: 21,
    lastError: null,
  })
  legacy.close()
}

async function seedLegacyQueueV135(dbName: string) {
  const legacy = new Dexie(dbName)
  legacy.version(135).stores({
    mobileOutboundQueue: "&id, status, [status+nextAttemptAt], createdAt, command",
  })
  await legacy.open()
  await legacy.table("mobileOutboundQueue").put({
    id: "legacy-action",
    command: "workflow_trigger_manual",
    payload: { workflowId: "wf-1" },
    status: "pending",
    attempts: 0,
    createdAt: 1,
    nextAttemptAt: 1,
    idempotencyKey: "legacy-key",
  })
  legacy.close()
}

describe("migrateLegacyDatabaseToAccount", () => {
  it("reports whether a legacy database exists without opening the account target", async () => {
    const sourceDbName = "cognia-legacy-exists-test"
    await deleteCogniaDb(sourceDbName)
    await expect(legacyDatabaseExists(sourceDbName)).resolves.toBe(false)

    await seedLegacyV86(sourceDbName)

    await expect(legacyDatabaseExists(sourceDbName)).resolves.toBe(true)
  }, 30000)

  it("copies representative v86 legacy data into account #1 and leaves account #2 invisible", async () => {
    const sourceDbName = "cognia-legacy-v86-migration-test"
    await deleteCogniaDb(sourceDbName)
    await deleteCogniaDb(accountDatabaseName("acct_legacy"))
    await deleteCogniaDb(accountDatabaseName("acct_second"))
    await seedLegacyV86(sourceDbName)
    const { db: registryDb, registry } = await createRegistry("legacy-v86")

    const result = await migrateLegacyDatabaseToAccount({
      registry,
      sourceDbName,
      targetAccountId: "acct_legacy",
      completedAt: 5000,
      batchSize: 2,
    })

    expect(result.targetDbName).toBe(accountDatabaseName("acct_legacy"))
    expect(result.tables.find((table) => table.name === "sessions")).toMatchObject({ copied: 1 })
    await expect(registry.getState()).resolves.toMatchObject({
      legacyMigration: {
        status: "completed",
        sourceDbName,
        targetAccountId: "acct_legacy",
        completedAt: 5000,
      },
    })

    const accountOne = new CogniaDB(accountDatabaseName("acct_legacy"))
    await accountOne.open()
    await expect(accountOne.settings.get("singleton")).resolves.toMatchObject({
      activeProjectId: "proj-A",
    })
    await expect(accountOne.projects.get("proj-A")).resolves.toMatchObject({ name: "Workspace A" })
    await expect(accountOne.sessions.get("s1")).resolves.toMatchObject({ projectId: "proj-A" })
    await expect(accountOne.messages.get("m1")).resolves.toMatchObject({ sessionId: "s1" })
    await expect(accountOne.adapterInstances.get("adapter-1")).resolves.toMatchObject({
      displayName: "Telegram",
    })
    await expect(accountOne.conversationOverrides.get("ov1")).resolves.toMatchObject({
      conversationKey: "telegram:adapter-1:chat-1",
    })
    await expect(accountOne.sharedLinks.get("share-1")).resolves.toMatchObject({
      ownerToken: "owner-token",
    })
    await expect(accountOne.pairedDevices.get("device-1")).resolves.toMatchObject({
      label: "Phone",
    })
    // Sync cursors are deliberately NOT carried over. Since v130 a cursor is
    // scoped to the host that issued it, and a legacy row has no host recorded
    // — it cannot be attributed to one after the fact, so the honest outcome is
    // one full re-pull rather than a watermark that might belong anywhere.
    await expect(accountOne.hostSyncCursors.count()).resolves.toBe(0)
    accountOne.close()

    const accountTwo = new CogniaDB(accountDatabaseName("acct_second"))
    await accountTwo.open()
    await expect(accountTwo.sessions.count()).resolves.toBe(0)
    await expect(accountTwo.messages.count()).resolves.toBe(0)
    await expect(accountTwo.sharedLinks.count()).resolves.toBe(0)
    accountTwo.close()

    const source = new CogniaDB(sourceDbName)
    await source.open()
    await expect(source.sessions.get("s1")).resolves.toMatchObject({ title: "Legacy session" })
    source.close()
    registryDb.close()
  }, 30000)

  it("uses the legacy database name and Date.now defaults when optional inputs are omitted", async () => {
    await deleteCogniaDb(LEGACY_COGNIA_DB_NAME)
    await deleteCogniaDb(accountDatabaseName("acct_legacy"))
    await seedLegacyV86(LEGACY_COGNIA_DB_NAME)
    const { db: registryDb, registry } = await createRegistry("legacy-defaults")
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(9000)

    const result = await migrateLegacyDatabaseToAccount({
      registry,
      targetAccountId: "acct_legacy",
    })

    expect(result.sourceDbName).toBe(LEGACY_COGNIA_DB_NAME)
    await expect(registry.getState()).resolves.toMatchObject({
      legacyMigration: {
        sourceDbName: LEGACY_COGNIA_DB_NAME,
        targetAccountId: "acct_legacy",
        completedAt: 9000,
      },
    })

    nowSpy.mockRestore()
    registryDb.close()
  }, 30000)

  it("attributes quarantined legacy queue rows to the account receiving the migration", async () => {
    const sourceDbName = "cognia-legacy-v135-queue-migration-test"
    await deleteCogniaDb(sourceDbName)
    await deleteCogniaDb(accountDatabaseName("acct_legacy"))
    await seedLegacyQueueV135(sourceDbName)
    const { db: registryDb, registry } = await createRegistry("legacy-v135-queue")

    await migrateLegacyDatabaseToAccount({
      registry,
      sourceDbName,
      targetAccountId: "acct_legacy",
    })

    const accountDb = new CogniaDB(accountDatabaseName("acct_legacy"))
    await accountDb.open()
    await expect(accountDb.mobileOutboundQueue.get("legacy-action")).resolves.toMatchObject({
      accountId: "acct_legacy",
      targetId: "legacy-mixed",
      status: "deadlettered",
    })
    accountDb.close()
    registryDb.close()
  }, 30000)

  it("rejects invalid migration inputs before writing the success marker", async () => {
    const { db: registryDb, registry } = await createRegistry("legacy-inputs")

    await expect(
      migrateLegacyDatabaseToAccount({
        registry,
        targetAccountId: "acct_legacy",
        sourceDbName: "missing-legacy-db",
        batchSize: 0,
      })
    ).rejects.toThrow(/batch size/i)

    await expect(
      migrateLegacyDatabaseToAccount({
        registry,
        targetAccountId: "acct_missing",
        sourceDbName: "missing-legacy-db",
      })
    ).rejects.toThrow(/does not exist/i)

    await expect(
      migrateLegacyDatabaseToAccount({
        registry,
        targetAccountId: "acct_legacy",
        sourceDbName: "missing-legacy-db",
      })
    ).rejects.toThrow(/legacy database/i)
    await expect(registry.getState()).resolves.not.toHaveProperty("legacyMigration")

    registryDb.close()
  })
})
