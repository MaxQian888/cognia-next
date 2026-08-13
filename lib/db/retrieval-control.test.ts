import { createRetrievalProfile, encryptContentEnvelope } from "@cognia/rag"

import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import {
  acknowledgeRetrievalTombstone,
  activateRetrievalGeneration,
  claimNextRetrievalJob,
  deleteRetrievalEntity,
  enqueueRetrievalJob,
  heartbeatStoredRetrievalJob,
  markRetrievalGenerationValidating,
  saveRetrievalProfile,
  stageRetrievalGeneration,
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
})
