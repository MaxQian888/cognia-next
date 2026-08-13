import {
  checkpointRetrievalMigration,
  finishRetrievalMigrationPhase,
  startRetrievalMigrationPhase,
  storeRetrievalEncryptedContent,
} from "@/lib/db/retrieval-control"
import { getDb } from "@/lib/db/schema"
import { encryptContentEnvelope } from "@cognia/rag"
import { hasNoLeakingPii } from "@cognia/redact"

export interface ContentMigrationRecord {
  entityType: string
  entityId: string
  corpusId: string
  generationId?: string
  canonical: string
  safeProjection: string
}

export interface ContentMigrationCrypto {
  keyId: string
  key: CryptoKey
}

function envelopeId(record: ContentMigrationRecord, kind: "canonical" | "safe_projection") {
  return `${record.entityType}:${record.entityId}:${kind}`
}

export async function migrateEncryptedContentBatch(input: {
  journalId: string
  records: readonly ContentMigrationRecord[]
  crypto: ContentMigrationCrypto
  batchSize?: number
  now?: number
}): Promise<{ processed: number; watermark?: string; complete: boolean }> {
  const journal = await startRetrievalMigrationPhase({
    id: input.journalId,
    phase: "encrypt_content",
    now: input.now,
  })
  if (journal.status === "succeeded") {
    return { processed: 0, watermark: journal.watermark, complete: true }
  }
  const records = [...input.records]
    .sort((left, right) => left.entityId.localeCompare(right.entityId))
    .filter((record) => !journal.watermark || record.entityId > journal.watermark)
    .slice(0, input.batchSize ?? 100)
  if (records.length === 0) {
    await finishRetrievalMigrationPhase({
      id: input.journalId,
      status: "succeeded",
      now: input.now,
    })
    return { processed: 0, watermark: journal.watermark, complete: true }
  }

  try {
    for (const record of records) {
      if (!record.entityType || !record.entityId || !record.corpusId || !record.canonical) {
        throw new Error("Migration record identity and canonical content are required")
      }
      if (!record.safeProjection.trim() || !hasNoLeakingPii(record.safeProjection)) {
        throw new Error("Safe projection failed the PII gate")
      }
      const createdAt = input.now ?? Date.now()
      for (const kind of ["canonical", "safe_projection"] as const) {
        const plainText = kind === "canonical" ? record.canonical : record.safeProjection
        const id = envelopeId(record, kind)
        await storeRetrievalEncryptedContent({
          id,
          entityType: record.entityType,
          entityId: record.entityId,
          corpusId: record.corpusId,
          generationId: record.generationId,
          kind,
          envelope: await encryptContentEnvelope(plainText, {
            key: input.crypto.key,
            keyId: input.crypto.keyId,
            additionalData: `retrieval-content-v1:${id}:${record.corpusId}`,
          }),
          createdAt,
          updatedAt: createdAt,
        })
      }
      await checkpointRetrievalMigration({
        id: input.journalId,
        watermark: record.entityId,
        processedDelta: 1,
        now: input.now,
      })
    }
  } catch (error) {
    await finishRetrievalMigrationPhase({
      id: input.journalId,
      status: "failed",
      failureCode: "content_encryption_failed",
      now: input.now,
    })
    throw error
  }

  const watermark = records.at(-1)?.entityId
  const remaining = input.records.some(
    (record) => watermark !== undefined && record.entityId > watermark
  )
  if (!remaining) {
    await finishRetrievalMigrationPhase({
      id: input.journalId,
      status: "succeeded",
      now: input.now,
    })
  }
  return { processed: records.length, watermark, complete: !remaining }
}

export async function verifyEncryptedCutover(records: readonly ContentMigrationRecord[]) {
  const db = getDb()
  const missing: string[] = []
  for (const record of records) {
    for (const kind of ["canonical", "safe_projection"] as const) {
      if (!(await db.retrievalEncryptedContent.get(envelopeId(record, kind)))) {
        missing.push(envelopeId(record, kind))
      }
    }
  }
  return { valid: missing.length === 0, missingEnvelopeIds: missing }
}
