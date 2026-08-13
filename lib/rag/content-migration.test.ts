import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { migrateEncryptedContentBatch, verifyEncryptedCutover } from "./content-migration"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("encrypted retrieval content migration", () => {
  it("checkpoints bounded batches and stores separate encrypted canonical/safe envelopes", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])
    const records = [
      {
        entityType: "memory",
        entityId: "m1",
        corpusId: "memory:profile",
        canonical: "Email alice@example.com",
        safeProjection: "Email <EMAIL_001>",
      },
      {
        entityType: "memory",
        entityId: "m2",
        corpusId: "memory:profile",
        canonical: "Project uses pnpm",
        safeProjection: "Project uses pnpm",
      },
    ]
    const cryptoInput = { key, keyId: "dek-1" }
    await expect(
      migrateEncryptedContentBatch({
        journalId: "migration:memory",
        records,
        crypto: cryptoInput,
        batchSize: 1,
        now: 1,
      })
    ).resolves.toEqual({ processed: 1, watermark: "m1", complete: false })
    await expect(
      migrateEncryptedContentBatch({
        journalId: "migration:memory",
        records,
        crypto: cryptoInput,
        batchSize: 1,
        now: 2,
      })
    ).resolves.toEqual({ processed: 1, watermark: "m2", complete: true })

    expect(await verifyEncryptedCutover(records)).toEqual({
      valid: true,
      missingEnvelopeIds: [],
    })
    const serialized = JSON.stringify(await getDb().retrievalEncryptedContent.toArray())
    expect(serialized).not.toContain("alice@example.com")
    expect(serialized).not.toContain("Project uses pnpm")
    expect(await getDb().retrievalMigrationJournal.get("migration:memory")).toMatchObject({
      status: "succeeded",
      processedCount: 2,
      watermark: "m2",
    })
  })

  it("fails closed when a safe projection still contains PII", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])
    await expect(
      migrateEncryptedContentBatch({
        journalId: "migration:unsafe",
        records: [
          {
            entityType: "memory",
            entityId: "m1",
            corpusId: "memory:profile",
            canonical: "alice@example.com",
            safeProjection: "alice@example.com",
          },
        ],
        crypto: { key, keyId: "dek-1" },
      })
    ).rejects.toThrow("PII gate")
    expect(await getDb().retrievalEncryptedContent.count()).toBe(0)
  })
})
