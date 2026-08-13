import {
  activateRetrievalGeneration,
  assertRetrievalOperationAllowed,
  failRetrievalGeneration,
  markRetrievalGenerationValidating,
  stageRetrievalGeneration,
} from "@/lib/db/retrieval-control"
import type { RetrievalDomain } from "@cognia/rag"
import type { IVectorStore, VectorDocument } from "@cognia/vector/store"

export interface GenerationStage<T> {
  value: T
  documents: VectorDocument[]
  count: number
}

export interface RunGenerationSwapInput<T> {
  idPrefix: string
  corpusId: string
  domain: RetrievalDomain
  profileFingerprint: string
  collection: string
  store: IVectorStore
  contentHash: string
  expectedCount: number
  expectedDimension?: number
  oldVectors: Array<{ collection: string; id: string }>
  now?: number
  build: (generationId: string) => GenerationStage<T>
  /** Must mutate domain rows and call `activate` in the same durable transaction. */
  commit: (value: T, activate: () => Promise<void>) => Promise<void>
}

export interface RunGenerationSwapResult<T> {
  value: T
  generationId: string
  vectorDocIds: string[]
  cleanupPending: boolean
}

export async function runGenerationSwap<T>(
  input: RunGenerationSwapInput<T>
): Promise<RunGenerationSwapResult<T>> {
  await assertRetrievalOperationAllowed("ingest")
  const now = input.now ?? Date.now()
  const generationId = `${input.idPrefix}_${now.toString(36)}_${crypto.randomUUID()}`
  await stageRetrievalGeneration({
    id: generationId,
    corpusId: input.corpusId,
    domain: input.domain,
    profileFingerprint: input.profileFingerprint,
    createdAt: now,
  })

  const stage = input.build(generationId)
  const vectorDocIds = stage.documents.map((document) => document.id)
  let activated = false
  try {
    if (stage.documents.length > 0) {
      await input.store.addDocuments(input.collection, stage.documents)
    }
    const dimensions = new Set(
      stage.documents
        .map((document) => document.embedding?.length)
        .filter((dimension): dimension is number => dimension !== undefined)
    )
    const actualDimension = dimensions.size === 1 ? [...dimensions][0] : undefined
    const valid =
      stage.count === input.expectedCount &&
      dimensions.size <= 1 &&
      (input.expectedDimension === undefined || actualDimension === input.expectedDimension)
    await markRetrievalGenerationValidating(generationId, {
      count: stage.count,
      contentHash: input.contentHash,
      dimensions: actualDimension,
      valid,
      ...(valid ? {} : { failureCode: "generation_validation_failed" }),
    })
    if (!valid) throw new Error("Retrieval generation validation failed")

    await input.commit(stage.value, async () => {
      await activateRetrievalGeneration(generationId, now)
    })
    activated = true
  } catch (error) {
    if (!activated) {
      await failRetrievalGeneration(generationId, "generation_write_failed", Date.now()).catch(
        () => undefined
      )
      if (vectorDocIds.length > 0 && typeof input.store.deleteDocuments === "function") {
        await input.store.deleteDocuments(input.collection, vectorDocIds).catch(() => undefined)
      }
    }
    throw error
  }

  let cleanupPending = false
  if (input.oldVectors.length > 0 && typeof input.store.deleteDocuments === "function") {
    const idsByCollection = new Map<string, string[]>()
    for (const vector of input.oldVectors) {
      const ids = idsByCollection.get(vector.collection) ?? []
      ids.push(vector.id)
      idsByCollection.set(vector.collection, ids)
    }
    for (const [collection, ids] of idsByCollection) {
      try {
        await input.store.deleteDocuments(collection, ids)
      } catch {
        cleanupPending = true
      }
    }
  }

  return { value: stage.value, generationId, vectorDocIds, cleanupPending }
}
