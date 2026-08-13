import {
  createKnowledgeBaseIngestJob,
  deleteKnowledgeBase,
  deleteKnowledgeBaseSource,
  getKnowledgeBaseReferences,
  getKnowledgeBaseSourcesByIds,
  listKnowledgeBaseChunksBySource,
  listKnowledgeBaseSources,
  listKnowledgeBaseVectorCollections,
  updateKnowledgeBaseIngestJob,
  updateKnowledgeBaseSource,
} from "@/lib/db/knowledge-bases"
import { prepareChunks } from "@/lib/twin/ingest/chunk"
import { embedRedactedChunks, type EmbeddingConfig } from "@/lib/twin/ingest/embed"
import { parseSource, type RawSource } from "@/lib/twin/ingest/parse"
import { persistKnowledgeBaseChunks } from "./persist"
import { EmbeddingDimensionMismatchError } from "@cognia/vector/dimension-guard"
import type { IVectorStore } from "@cognia/vector/store"
import { redactText, translateOffsetsThroughRedaction, unredactText } from "@cognia/redact"
import type { VectorBackend } from "@/types/twin"
import type { KnowledgeBaseReference, KnowledgeBaseSource } from "@/types/knowledge-base"

export interface KnowledgeBaseIngestDeps {
  store: IVectorStore
  embedding: EmbeddingConfig
  vectorBackend: VectorBackend
  /** Generation namespace override used by safe full-library rebuilds. */
  vectorCollection?: string
}

export interface IngestKnowledgeBaseSourceInput {
  sourceId: string
  deps: KnowledgeBaseIngestDeps
  signal?: AbortSignal
  /** Test/worker seam for alternative parsers; production uses the shared Twin parser. */
  parse?: typeof parseSource
}

export interface IngestKnowledgeBaseSourceResult {
  jobId: string
  status: "completed" | "cancelled"
  chunkCount: number
  tokensUsed: number
}

export interface RebuildKnowledgeBaseIndexResult {
  completedSourceIds: string[]
  failedSourceIds: string[]
}

export async function removeKnowledgeBaseSource(
  sourceId: string,
  deps?: Pick<KnowledgeBaseIngestDeps, "store">
): Promise<void> {
  const chunks = await listKnowledgeBaseChunksBySource(sourceId)
  if (deps?.store.deleteDocuments) {
    const idsByCollection = new Map<string, string[]>()
    for (const chunk of chunks) {
      const ids = idsByCollection.get(chunk.vectorCollection) ?? []
      ids.push(chunk.vectorDocId)
      idsByCollection.set(chunk.vectorCollection, ids)
    }
    for (const [collection, ids] of idsByCollection) {
      try {
        await deps.store.deleteDocuments(collection, ids)
      } catch {
        // Derived remote vectors can be reconciled; local ownership is canonical.
      }
    }
  }
  await deleteKnowledgeBaseSource(sourceId)
}

export async function removeKnowledgeBase(
  knowledgeBaseId: string,
  options: {
    detachReferences?: boolean
    deps?: Pick<KnowledgeBaseIngestDeps, "store">
  } = {}
): Promise<{ detachedReferences: KnowledgeBaseReference[] }> {
  const references = await getKnowledgeBaseReferences(knowledgeBaseId)
  if (references.length > 0 && !options.detachReferences) {
    return deleteKnowledgeBase(knowledgeBaseId)
  }
  if (options.deps) {
    const collections = await listKnowledgeBaseVectorCollections(knowledgeBaseId)
    if (collections.length === 0) collections.push(`cognia_kb_${knowledgeBaseId}`)
    for (const collection of collections) {
      try {
        await options.deps.store.deleteCollection(collection)
      } catch {
        // Local deletion remains authoritative if a derived remote index is unavailable.
      }
    }
  }
  return deleteKnowledgeBase(knowledgeBaseId, {
    detachReferences: options.detachReferences,
  })
}

export async function rebuildKnowledgeBaseIndex(
  knowledgeBaseId: string,
  deps: KnowledgeBaseIngestDeps
): Promise<RebuildKnowledgeBaseIndexResult> {
  const sources = await listKnowledgeBaseSources(knowledgeBaseId)
  const generationCollection = `cognia_kb_${knowledgeBaseId}__rebuild_${Date.now().toString(36)}`

  const result: RebuildKnowledgeBaseIndexResult = {
    completedSourceIds: [],
    failedSourceIds: [],
  }
  for (const source of sources) {
    try {
      await ingestKnowledgeBaseSource({
        sourceId: source.id,
        deps: { ...deps, vectorCollection: generationCollection },
      })
      result.completedSourceIds.push(source.id)
    } catch {
      result.failedSourceIds.push(source.id)
    }
  }
  return result
}

type IngestPhase = "parsing" | "redacting" | "chunking" | "embedding" | "persisting"

function decodeBase64(value: string): Uint8Array {
  const decoded = globalThis.atob(value)
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}

function rawSourceFromRow(source: KnowledgeBaseSource): RawSource {
  const provenance = source.originalLocation ?? source.title
  if (source.contentEncoding === "base64") {
    return {
      id: source.id,
      filename: provenance,
      format: source.format,
      binary: decodeBase64(source.content),
    }
  }
  return {
    id: source.id,
    filename: provenance,
    format: source.format,
    text: source.content,
  }
}

function failureCode(error: unknown, phase: IngestPhase): string {
  if (error instanceof EmbeddingDimensionMismatchError) return "embedding_dimension_mismatch"
  return `${phase}_failed`
}

export async function ingestKnowledgeBaseSource(
  input: IngestKnowledgeBaseSourceInput
): Promise<IngestKnowledgeBaseSourceResult> {
  const [source] = await getKnowledgeBaseSourcesByIds([input.sourceId])
  if (!source) throw new Error("Knowledge Base source not found")

  const job = await createKnowledgeBaseIngestJob({
    knowledgeBaseId: source.knowledgeBaseId,
    sourceId: source.id,
  })
  const cancelled = async (): Promise<IngestKnowledgeBaseSourceResult> => {
    await updateKnowledgeBaseIngestJob(job.id, {
      status: "cancelled",
      phase: "cancelled",
      completedAt: Date.now(),
    })
    if (source.status !== "processing") {
      await updateKnowledgeBaseSource(source.id, {
        status: source.status,
        chunkCount: source.chunkCount,
        errorCode: source.errorCode,
      })
    }
    return { jobId: job.id, status: "cancelled", chunkCount: 0, tokensUsed: 0 }
  }

  if (input.signal?.aborted) return cancelled()

  await updateKnowledgeBaseIngestJob(job.id, {
    status: "running",
    phase: "parsing",
    progress: 10,
    attempts: 1,
    startedAt: Date.now(),
    errorCode: undefined,
  })
  await updateKnowledgeBaseSource(source.id, {
    status: "processing",
    errorCode: undefined,
  })

  let phase: IngestPhase = "parsing"
  try {
    const parsed = await (input.parse ?? parseSource)(rawSourceFromRow(source))
    if (input.signal?.aborted) return cancelled()

    phase = "redacting"
    await updateKnowledgeBaseIngestJob(job.id, { phase, progress: 25 })
    const redactForCloud = input.deps.vectorBackend !== "native"
    const redaction = redactForCloud
      ? redactText(parsed.embeddableText, parsed.baseMetadata.speakers ?? [])
      : null
    const redactedText = redaction?.redacted ?? parsed.embeddableText
    if (input.signal?.aborted) return cancelled()

    phase = "chunking"
    await updateKnowledgeBaseIngestJob(job.id, { phase, progress: 45 })
    const pageMap =
      redaction && parsed.pageMap
        ? translateOffsetsThroughRedaction(parsed.pageMap, redactedText, redaction.map)
        : parsed.pageMap
    const prepared = prepareChunks({
      redactedText,
      originalText: parsed.originalText,
      format: parsed.format,
      baseMetadata: parsed.baseMetadata,
      ...(pageMap ? { pageMap } : {}),
    })
    const chunks = prepared.map((chunk) => ({
      ...chunk,
      contentRedacted: chunk.content,
      content: redaction ? unredactText(chunk.content, redaction.map) : chunk.content,
    }))
    if (input.signal?.aborted) return cancelled()

    phase = "embedding"
    await updateKnowledgeBaseIngestJob(job.id, { phase, progress: 65 })
    const embeddingResult = await embedRedactedChunks(
      chunks.map((chunk) => chunk.contentRedacted),
      input.deps.embedding
    )
    if (input.signal?.aborted) return cancelled()

    phase = "persisting"
    await updateKnowledgeBaseIngestJob(job.id, { phase, progress: 85 })
    const persisted = await persistKnowledgeBaseChunks({
      knowledgeBaseId: source.knowledgeBaseId,
      sourceId: source.id,
      vectorBackend: input.deps.vectorBackend,
      store: input.deps.store,
      vectorCollection: input.deps.vectorCollection,
      contentHash: source.fingerprint,
      chunks,
      embeddings: embeddingResult.embeddings,
    })

    const completedAt = Date.now()
    await updateKnowledgeBaseSource(
      source.id,
      { status: "ready", chunkCount: persisted.rows.length, errorCode: undefined },
      completedAt
    )
    await updateKnowledgeBaseIngestJob(
      job.id,
      {
        status: "completed",
        phase: "completed",
        progress: 100,
        completedAt,
        errorCode: undefined,
      },
      completedAt
    )
    return {
      jobId: job.id,
      status: "completed",
      chunkCount: persisted.rows.length,
      tokensUsed: embeddingResult.tokensUsed ?? 0,
    }
  } catch (error) {
    const errorCode = failureCode(error, phase)
    const failedAt = Date.now()
    await Promise.all([
      updateKnowledgeBaseSource(source.id, { status: "failed", errorCode }, failedAt),
      updateKnowledgeBaseIngestJob(
        job.id,
        {
          status: "failed",
          phase: "failed",
          completedAt: failedAt,
          errorCode,
        },
        failedAt
      ),
    ])
    throw error
  }
}
