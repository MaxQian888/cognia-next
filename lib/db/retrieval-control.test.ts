import { createRetrievalProfile, encryptContentEnvelope } from "@cognia/rag"

import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import {
  acknowledgeRetrievalTombstone,
  activateRetrievalGeneration,
  assertRetrievalOperationAllowed,
  claimNextRetrievalJob,
  checkpointRetrievalMigration,
  deleteRetrievalEntity,
  enqueueRetrievalJob,
  failRetrievalGeneration,
  getActiveRetrievalGeneration,
  heartbeatStoredRetrievalJob,
  markRetrievalGenerationValidating,
  finishRetrievalMigrationPhase,
  pruneRetrievalControlData,
  reconcileRetrievalCorpus,
  setRetrievalKillSwitch,
  saveRetrievalProfile,
  stageRetrievalGeneration,
  startRetrievalMigrationPhase,
  storeRetrievalEncryptedContent,
} from "./retrieval-control"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("retrieval control repository", () => {
  it("stores a profile and atomically switches the active generation", async () => {
    const profile = createRetrievalProfile({
      id: "profile-1",
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      vector: { backend: "native", collectionPolicy: "generation" },
    })
    const saved = await saveRetrievalProfile(profile, 1)
    await stageRetrievalGeneration({
      id: "g1",
      corpusId: "project:1",
      domain: "project",
      profileFingerprint: saved.fingerprint,
      createdAt: 2,
    })
    await markRetrievalGenerationValidating("g1", {
      count: 10,
      contentHash: "hash-1",
      dimensions: 1536,
      valid: true,
    })
    await activateRetrievalGeneration("g1", 3)

    await stageRetrievalGeneration({
      id: "g2",
      corpusId: "project:1",
      domain: "project",
      profileFingerprint: saved.fingerprint,
      createdAt: 4,
    })
    await markRetrievalGenerationValidating("g2", {
      count: 11,
      contentHash: "hash-2",
      dimensions: 1536,
      valid: true,
    })
    await activateRetrievalGeneration("g2", 5)

    expect(await getDb().retrievalActivePointers.get("project:1")).toMatchObject({
      generationId: "g2",
    })
    expect(await getDb().retrievalGenerations.get("g1")).toMatchObject({ status: "retiring" })
    expect(await getDb().retrievalGenerations.get("g2")).toMatchObject({ status: "active" })
    expect(await getActiveRetrievalGeneration("project:1")).toMatchObject({ id: "g2" })
  })

  it("marks an unactivated generation failed without moving the active pointer", async () => {
    await stageRetrievalGeneration({
      id: "failed-generation",
      corpusId: "project:failed",
      domain: "project",
      profileFingerprint: "profile-fingerprint",
      createdAt: 1,
    })
    await failRetrievalGeneration("failed-generation", "remote_write_failed", 2)

    expect(await getDb().retrievalGenerations.get("failed-generation")).toMatchObject({
      status: "failed",
      failedAt: 2,
      validation: { valid: false, failureCode: "remote_write_failed" },
    })
    expect(await getDb().retrievalActivePointers.get("project:failed")).toBeUndefined()
  })

  it("deduplicates durable jobs and renews only the owning worker lease", async () => {
    const draft = {
      id: "job-1",
      dedupeKey: "reindex:project:1:fp",
      kind: "reindex" as const,
      corpusId: "project:1",
      queuedAt: 100,
      maxAttempts: 3,
    }
    expect((await enqueueRetrievalJob(draft)).id).toBe("job-1")
    expect((await enqueueRetrievalJob({ ...draft, id: "job-2" })).id).toBe("job-1")

    const claimed = await claimNextRetrievalJob("worker-1", 100, 50)
    expect(claimed).toMatchObject({ id: "job-1", status: "running", attempt: 1 })
    await expect(heartbeatStoredRetrievalJob("job-1", "worker-2", 120, 50)).rejects.toThrow(
      "lease owner"
    )
    await expect(heartbeatStoredRetrievalJob("job-1", "worker-1", 120, 50)).resolves.toMatchObject({
      leaseExpiresAt: 170,
    })
  })

  it("deletes ciphertext rows and retains a tombstone until every device acknowledges", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])
    const envelope = await encryptContentEnvelope("secret", {
      key,
      keyId: "dek",
      additionalData: "memory:m1:canonical",
    })
    await storeRetrievalEncryptedContent({
      id: "memory:m1:canonical",
      entityType: "memory",
      entityId: "m1",
      corpusId: "memory:profile",
      kind: "canonical",
      envelope,
      createdAt: 1,
      updatedAt: 1,
    })

    const tombstone = await deleteRetrievalEntity({
      entityType: "memory",
      entityId: "m1",
      corpusId: "memory:profile",
      knownDeviceIds: ["phone", "desktop"],
      now: 10,
    })
    expect(await getDb().retrievalEncryptedContent.count()).toBe(0)
    expect(tombstone.eligiblePurgeAt).toBeUndefined()
    expect(
      (await acknowledgeRetrievalTombstone(tombstone.id, "phone", 20)).eligiblePurgeAt
    ).toBeUndefined()
    expect((await acknowledgeRetrievalTombstone(tombstone.id, "desktop", 30)).eligiblePurgeAt).toBe(
      30 + 30 * 24 * 60 * 60 * 1000
    )
  })

  it("resumes migration phases from a durable watermark", async () => {
    await startRetrievalMigrationPhase({
      id: "migration:encrypt",
      phase: "encrypt_content",
      now: 1,
    })
    await checkpointRetrievalMigration({
      id: "migration:encrypt",
      watermark: "memory:100",
      processedDelta: 100,
      now: 2,
    })
    await startRetrievalMigrationPhase({
      id: "migration:encrypt",
      phase: "encrypt_content",
      now: 3,
    })
    expect(await getDb().retrievalMigrationJournal.get("migration:encrypt")).toMatchObject({
      watermark: "memory:100",
      processedCount: 100,
      status: "running",
    })
    await finishRetrievalMigrationPhase({ id: "migration:encrypt", status: "succeeded", now: 4 })
    await expect(
      startRetrievalMigrationPhase({ id: "migration:encrypt", phase: "encrypt_content", now: 5 })
    ).resolves.toMatchObject({ status: "succeeded", watermark: "memory:100" })
  })

  it("repairs a missing active pointer and reports both reconciliation directions", async () => {
    await stageRetrievalGeneration({
      id: "g-reconcile",
      corpusId: "twin:1",
      domain: "twin",
      profileFingerprint: "fingerprint",
      createdAt: 1,
    })
    await markRetrievalGenerationValidating("g-reconcile", {
      count: 2,
      contentHash: "hash",
      valid: true,
    })
    await activateRetrievalGeneration("g-reconcile", 2)
    await getDb().retrievalActivePointers.delete("twin:1")

    await expect(
      reconcileRetrievalCorpus({
        corpusId: "twin:1",
        localVectorIds: ["shared", "local-only"],
        remoteVectorIds: ["shared", "remote-only"],
        now: 3,
      })
    ).resolves.toEqual({
      corpusId: "twin:1",
      activeGenerationId: "g-reconcile",
      pointerRepaired: true,
      remoteWithoutLocalIds: ["remote-only"],
      localWithoutRemoteIds: ["local-only"],
      countMismatch: false,
    })
  })

  it("prunes terminal jobs and traces by age and configured caps", async () => {
    const now = 100 * 24 * 60 * 60 * 1000
    await getDb().retrievalJobs.bulkAdd([
      {
        id: "old-success",
        dedupeKey: "old-success",
        kind: "reindex",
        corpusId: "project:1",
        status: "succeeded",
        queuedAt: 1,
        completedAt: 1,
        attempt: 1,
        maxAttempts: 1,
      },
      {
        id: "new-success",
        dedupeKey: "new-success",
        kind: "reindex",
        corpusId: "project:1",
        status: "succeeded",
        queuedAt: now - 1,
        completedAt: now - 1,
        attempt: 1,
        maxAttempts: 1,
      },
    ])
    const trace = (traceId: string, createdAt: number, expiresAt: number) =>
      ({ traceId, createdAt, expiresAt }) as never
    await getDb().retrievalTraces.bulkAdd([
      trace("expired", 1, now - 1),
      trace("newest", now - 1, now + 1),
      trace("second", now - 2, now + 1),
    ])

    await expect(pruneRetrievalControlData(now, { jobs: 1, traces: 1 })).resolves.toEqual({
      jobsDeleted: 1,
      tracesDeleted: 2,
    })
    expect((await getDb().retrievalJobs.toArray()).map((row) => row.id)).toEqual(["new-success"])
    expect((await getDb().retrievalTraces.toArray()).map((row) => row.traceId)).toEqual(["newest"])
  })

  it("stops new retrieval work but leaves recovery and lexical reads available", async () => {
    await setRetrievalKillSwitch({
      engaged: true,
      changedBy: "safety",
      reasonCode: "migration_guard",
      now: 1,
    })
    await expect(assertRetrievalOperationAllowed("ingest")).rejects.toMatchObject({
      name: "RetrievalKillSwitchError",
    })
    await expect(assertRetrievalOperationAllowed("promotion")).rejects.toThrow("kill switch")
    await expect(assertRetrievalOperationAllowed("decrypt")).resolves.toBeUndefined()
    await expect(assertRetrievalOperationAllowed("reconcile")).resolves.toBeUndefined()
    await expect(assertRetrievalOperationAllowed("lexical_read")).resolves.toBeUndefined()

    await setRetrievalKillSwitch({ engaged: false, changedBy: "user", now: 2 })
    await expect(assertRetrievalOperationAllowed("ingest")).resolves.toBeUndefined()
  })
})
