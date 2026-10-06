import { getKnowledgeBaseSourcesByIds } from "@/lib/db/knowledge-bases"
import { getDb } from "@/lib/db/schema"
import { runGenerationSwap } from "@/lib/rag/generation-ingest"
import { knowledgeBaseVectorCollectionName } from "@/lib/knowledge-base/runtime/retrieve"
import { ensureCollectionDimensionCompatible } from "@cognia/vector/dimension-guard"
import { documentContentHash } from "@cognia/document/document-structure"
import type { IVectorStore } from "@cognia/vector/store"
import type {
  KnowledgeBaseChunk,
  KnowledgeBaseDocumentSnapshot,
  KnowledgeBaseSource,
} from "@/types/knowledge-base"
import type { ChunkingStrategyId, TwinChunkMetadata, VectorBackend } from "@/types/twin"

export interface PersistKnowledgeBaseChunksInput {
  knowledgeBaseId: string
  sourceId: string
  vectorBackend: VectorBackend
  vectorCollection?: string
  store: IVectorStore
  contentHash: string
  profileFingerprint?: string
  documentSnapshot?: Omit<
    KnowledgeBaseDocumentSnapshot,
    "generationId" | "contentHash" | "createdAt"
  >
  /** Compare the parsed source again inside the activation transaction. */
  expectedSource?: Pick<
    KnowledgeBaseSource,
    "fingerprint" | "content" | "contentEncoding" | "format"
  >
  expectedSourceFingerprint?: string
  signal?: AbortSignal
  chunks: Array<{
    content: string
    contentRedacted: string
    charStart: number
    charEnd: number
    strategy: ChunkingStrategyId
    tokenCount: number
    metadata: TwinChunkMetadata
  }>
  embeddings: number[][]
}

export class KnowledgeBaseSourceChangedError extends Error {
  readonly code = "source_changed"
  constructor() {
    super("Knowledge Base source changed during ingestion")
    this.name = "KnowledgeBaseSourceChangedError"
  }
}

export interface PersistKnowledgeBaseChunksResult {
  rows: KnowledgeBaseChunk[]
  vectorDocIds: string[]
  generationId?: string
  cleanupPending?: boolean
}

function vectorDocId(
  knowledgeBaseId: string,
  sourceId: string,
  generationId: string,
  index: number
): string {
  return `${knowledgeBaseId}__${sourceId}__${generationId}__${index.toString(36)}`
}

function canonicalChunkMetadata(
  chunk: PersistKnowledgeBaseChunksInput["chunks"][number],
  snapshot: PersistKnowledgeBaseChunksInput["documentSnapshot"]
): TwinChunkMetadata {
  const structure = snapshot?.structure
  if (!snapshot || !structure) return chunk.metadata
  const section = structure.nodes
    .filter((node) => node.charStart <= chunk.charStart && node.charEnd >= chunk.charEnd)
    .sort((left, right) => right.level - left.level)[0]
  const pages = structure.pages.filter(
    (page) => page.charEnd > chunk.charStart && page.charStart < chunk.charEnd
  )
  return {
    ...chunk.metadata,
    documentVersion: structure.contentHash,
    ...(section ? { sectionId: section.id } : {}),
    lineStart: snapshot.originalText.slice(0, chunk.charStart).split("\n").length,
    lineEnd: snapshot.originalText
      .slice(0, Math.max(chunk.charStart, chunk.charEnd - 1))
      .split("\n").length,
    ...(pages.length
      ? {
          pageNumber: pages[0].pageNumber,
          ...(pages.length > 1 ? { pageEnd: pages.at(-1)!.pageNumber } : {}),
        }
      : {}),
  }
}

export async function persistKnowledgeBaseChunks(
  input: PersistKnowledgeBaseChunksInput
): Promise<PersistKnowledgeBaseChunksResult> {
  if (input.chunks.length !== input.embeddings.length) {
    throw new Error(
      `persistKnowledgeBaseChunks: chunks (${input.chunks.length}) and embeddings (${input.embeddings.length}) length mismatch`
    )
  }
  const snapshot = input.documentSnapshot
  if (
    snapshot &&
    (typeof snapshot.originalText !== "string" ||
      typeof snapshot.title !== "string" ||
      !snapshot.format)
  ) {
    throw new Error("Knowledge Base document snapshot is invalid; parse the source again")
  }
  if (
    snapshot?.structure &&
    (snapshot.structure.version !== 1 ||
      snapshot.structure.textLength !== snapshot.originalText.length ||
      snapshot.structure.contentHash !== documentContentHash(snapshot.originalText))
  ) {
    throw new Error("Knowledge Base document structure does not match original text")
  }

  const [source] = await getKnowledgeBaseSourcesByIds([input.sourceId])
  if (!source || source.knowledgeBaseId !== input.knowledgeBaseId) {
    throw new Error("Knowledge Base source ownership does not match")
  }

  const collectionBase =
    input.vectorCollection ?? knowledgeBaseVectorCollectionName(input.knowledgeBaseId)
  const dimension = input.embeddings[0]?.length
  const collectionForGeneration = (generationId: string) => `${collectionBase}__${generationId}`

  const now = Date.now()
  let builtGenerationId: string | undefined
  const result = await runGenerationSwap({
    idPrefix: "kbgen",
    corpusId: `knowledge_base:${input.knowledgeBaseId}:source:${input.sourceId}`,
    domain: "kb",
    profileFingerprint:
      input.profileFingerprint ?? `legacy:${input.vectorBackend}:${dimension ?? "none"}`,
    collection: collectionForGeneration,
    prepare: async (collection) => {
      await ensureCollectionDimensionCompatible(input.store, collection, dimension)
      if (dimension !== undefined) {
        try {
          await input.store.createCollection(collection, { dimension })
        } catch {
          // Existing collections are valid after the dimension guard above.
        }
      }
    },
    store: input.store,
    contentHash: input.contentHash,
    expectedCount: input.chunks.length,
    expectedDimension: dimension,
    // Immutable revisions retain their vectors; deletion is governed by retention/tombstones.
    oldVectors: [],
    now,
    build: (generationId) => {
      builtGenerationId = generationId
      const rows: KnowledgeBaseChunk[] = input.chunks.map((chunk, index) => ({
        id: `kbc_${now.toString(36)}_${index}_${Math.random().toString(36).slice(2, 6)}`,
        knowledgeBaseId: input.knowledgeBaseId,
        sourceId: input.sourceId,
        content: chunk.content,
        contentRedacted: chunk.contentRedacted,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        vectorBackend: input.vectorBackend,
        vectorCollection: collectionForGeneration(generationId),
        vectorDocId: vectorDocId(input.knowledgeBaseId, input.sourceId, generationId, index),
        generationId,
        strategy: chunk.strategy,
        tokenCount: chunk.tokenCount,
        metadata: canonicalChunkMetadata(chunk, snapshot),
        contentHash: input.contentHash,
        createdAt: now,
      }))
      return {
        value: rows,
        count: rows.length,
        documents: rows.map((row, index) => ({
          id: row.vectorDocId,
          content: row.contentRedacted,
          metadata: {
            knowledgeBaseId: row.knowledgeBaseId,
            chunkId: row.id,
            sourceId: row.sourceId,
            generationId: row.generationId,
          },
          embedding: input.embeddings[index],
        })),
      }
    },
    commit: async (rows, activate) => {
      const db = getDb()
      await db.transaction(
        "rw",
        [
          db.knowledgeBaseSources,
          db.knowledgeBaseChunks,
          db.retrievalGenerations,
          db.retrievalActivePointers,
        ],
        async () => {
          if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError")
          const current = await db.knowledgeBaseSources.get(input.sourceId)
          if (!current || current.knowledgeBaseId !== input.knowledgeBaseId)
            throw new KnowledgeBaseSourceChangedError()
          const expected = input.expectedSource ?? source
          if (
            (input.expectedSourceFingerprint !== undefined &&
              current.fingerprint !== input.expectedSourceFingerprint) ||
            (expected &&
              (current.fingerprint !== expected.fingerprint ||
                current.content !== expected.content ||
                current.contentEncoding !== expected.contentEncoding ||
                current.format !== expected.format))
          ) {
            throw new KnowledgeBaseSourceChangedError()
          }
          if (input.documentSnapshot) {
            // The generation id also exists on empty revisions; capture it from build below.
            const ownGenerationId = builtGenerationId
            const generation = ownGenerationId
              ? await db.retrievalGenerations.get(ownGenerationId)
              : undefined
            if (
              !ownGenerationId ||
              generation?.status !== "validating" ||
              generation.validation?.contentHash !== input.contentHash
            )
              throw new Error("Knowledge Base snapshot generation is unavailable")
            await db.knowledgeBaseSources.update(input.sourceId, {
              generationSnapshots: {
                ...current.generationSnapshots,
                [ownGenerationId]: {
                  ...input.documentSnapshot,
                  generationId: ownGenerationId,
                  contentHash: input.contentHash,
                  createdAt: now,
                },
              },
              status: "ready",
              chunkCount: rows.length,
              errorCode: undefined,
              updatedAt: now,
            })
          }
          if (rows.length > 0) await db.knowledgeBaseChunks.bulkPut(rows)
          await activate()
        }
      )
    },
  })

  return {
    rows: result.value,
    vectorDocIds: result.vectorDocIds,
    generationId: result.generationId,
    cleanupPending: result.cleanupPending,
  }
}
