import type { IVectorStore, VectorDocument } from "@cognia/vector/store"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  createKnowledgeBase,
  createKnowledgeBaseSource,
  listKnowledgeBaseChunks,
} from "@/lib/db/knowledge-bases"
import { knowledgeBaseVectorCollectionName } from "@/lib/knowledge-base/runtime/retrieve"
import { persistKnowledgeBaseChunks } from "./persist"

const dbFixture = createDbTestFixture({
  emptyTables: ["knowledgeBases", "knowledgeBaseSources", "knowledgeBaseChunks"],
})

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function createStore(existingDimension?: number) {
  const documents = new Map<string, VectorDocument>()
  return {
    provider: "native",
    documents,
    getCollectionInfo: jest.fn(async () => {
      if (existingDimension === undefined) throw new Error("missing")
      return { name: "collection", documentCount: documents.size, dimension: existingDimension }
    }),
    createCollection: jest.fn(async () => undefined),
    addDocuments: jest.fn(async (_collection: string, rows: VectorDocument[]) => {
      for (const row of rows) documents.set(row.id, row)
    }),
    deleteDocuments: jest.fn(async (_collection: string, ids: string[]) => {
      for (const id of ids) documents.delete(id)
    }),
  } as unknown as IVectorStore & {
    documents: Map<string, VectorDocument>
    createCollection: jest.Mock
    addDocuments: jest.Mock
    deleteDocuments: jest.Mock
  }
}

async function seedSource() {
  await createKnowledgeBase({ id: "kb-1", name: "Product", now: 1 })
  await createKnowledgeBaseSource({
    id: "source-1",
    knowledgeBaseId: "kb-1",
    kind: "document",
    format: "markdown",
    title: "Guide",
    content: "Alice can be reached at alice@example.com",
    fingerprint: "sha256:guide",
    now: 2,
  })
}

const chunk = {
  content: "Alice can be reached at alice@example.com",
  contentRedacted: "[NAME_1] can be reached at [EMAIL_1]",
  charStart: 0,
  charEnd: 39,
  strategy: "paragraph" as const,
  tokenCount: 10,
  metadata: {},
}

describe("persistKnowledgeBaseChunks", () => {
  it("stores full local provenance while sending only redacted content to the vector store", async () => {
    await seedSource()
    const store = createStore()

    const result = await persistKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      sourceId: "source-1",
      vectorBackend: "native",
      store,
      contentHash: "sha256:guide",
      chunks: [chunk],
      embeddings: [[0.1, 0.2]],
    })

    const collection = knowledgeBaseVectorCollectionName("kb-1")
    expect(store.createCollection).toHaveBeenCalledWith(collection, { dimension: 2 })
    expect(store.addDocuments).toHaveBeenCalledWith(collection, [
      expect.objectContaining({
        id: expect.stringMatching(/^kb-1__source-1__kbgen_.+__0$/),
        content: chunk.contentRedacted,
        metadata: expect.objectContaining({
          knowledgeBaseId: "kb-1",
          sourceId: "source-1",
        }),
      }),
    ])
    expect(result.vectorDocIds[0]).toMatch(/^kb-1__source-1__kbgen_.+__0$/)
    expect(await listKnowledgeBaseChunks("kb-1")).toEqual([
      expect.objectContaining({
        content: chunk.content,
        contentRedacted: chunk.contentRedacted,
        contentHash: "sha256:guide",
        vectorDocId: result.vectorDocIds[0],
        generationId: result.generationId,
      }),
    ])
  })

  it("idempotently replaces a source's previous local and remote chunks", async () => {
    await seedSource()
    const store = createStore()
    const base = {
      knowledgeBaseId: "kb-1",
      sourceId: "source-1",
      vectorBackend: "native" as const,
      store,
      contentHash: "sha256:guide",
    }
    await persistKnowledgeBaseChunks({ ...base, chunks: [chunk], embeddings: [[0.1, 0.2]] })

    await persistKnowledgeBaseChunks({
      ...base,
      chunks: [chunk, { ...chunk, content: "Second", contentRedacted: "Second" }],
      embeddings: [
        [0.3, 0.4],
        [0.5, 0.6],
      ],
    })

    expect(store.deleteDocuments).toHaveBeenCalledWith(knowledgeBaseVectorCollectionName("kb-1"), [
      expect.stringMatching(/^kb-1__source-1__kbgen_.+__0$/),
    ])
    expect((await listKnowledgeBaseChunks("kb-1")).map((row) => row.vectorDocId)).toEqual([
      expect.stringMatching(/^kb-1__source-1__kbgen_.+__0$/),
      expect.stringMatching(/^kb-1__source-1__kbgen_.+__1$/),
    ])
  })

  it("rejects malformed batches and incompatible embedding dimensions before writing", async () => {
    await seedSource()
    const store = createStore(3)
    const input = {
      knowledgeBaseId: "kb-1",
      sourceId: "source-1",
      vectorBackend: "native" as const,
      store,
      contentHash: "sha256:guide",
      chunks: [chunk],
    }

    await expect(persistKnowledgeBaseChunks({ ...input, embeddings: [] })).rejects.toThrow(
      "length mismatch"
    )
    await expect(
      persistKnowledgeBaseChunks({ ...input, embeddings: [[0.1, 0.2]] })
    ).rejects.toMatchObject({ name: "EmbeddingDimensionMismatchError" })
    expect(store.addDocuments).not.toHaveBeenCalled()
  })

  it("replaces stale chunks with an empty derived index", async () => {
    await seedSource()
    const store = createStore()
    const base = {
      knowledgeBaseId: "kb-1",
      sourceId: "source-1",
      vectorBackend: "native" as const,
      store,
      contentHash: "sha256:guide",
    }
    await persistKnowledgeBaseChunks({ ...base, chunks: [chunk], embeddings: [[0.1, 0.2]] })

    const result = await persistKnowledgeBaseChunks({ ...base, chunks: [], embeddings: [] })

    expect(result).toEqual(
      expect.objectContaining({ rows: [], vectorDocIds: [], generationId: expect.any(String) })
    )
    expect(await listKnowledgeBaseChunks("kb-1")).toEqual([])
  })

  it("validates source ownership before writing remote vectors", async () => {
    await seedSource()
    const store = createStore()
    await expect(
      persistKnowledgeBaseChunks({
        knowledgeBaseId: "kb-other",
        sourceId: "source-1",
        vectorBackend: "native",
        store,
        contentHash: "hash",
        chunks: [chunk],
        embeddings: [[0.1, 0.2]],
      })
    ).rejects.toThrow("ownership does not match")
    expect(store.addDocuments).not.toHaveBeenCalled()
  })

  it("continues an idempotent replace when collection creation or remote cleanup reports an error", async () => {
    await seedSource()
    const store = createStore()
    await persistKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      sourceId: "source-1",
      vectorBackend: "native",
      store,
      contentHash: "hash",
      chunks: [chunk],
      embeddings: [[0.1, 0.2]],
    })
    jest.mocked(store.createCollection).mockRejectedValueOnce(new Error("already exists"))
    jest.mocked(store.deleteDocuments).mockRejectedValueOnce(new Error("cleanup unavailable"))

    const result = await persistKnowledgeBaseChunks({
      knowledgeBaseId: "kb-1",
      sourceId: "source-1",
      vectorBackend: "native",
      store,
      contentHash: "hash-2",
      chunks: [{ ...chunk, content: "updated", contentRedacted: "updated" }],
      embeddings: [[0.3, 0.4]],
    })
    expect(result.cleanupPending).toBe(true)
    expect(result.vectorDocIds[0]).toMatch(/^kb-1__source-1__kbgen_.+__0$/)
  })

  it("keeps the active chunks when a replacement vector write fails", async () => {
    await seedSource()
    const store = createStore()
    const base = {
      knowledgeBaseId: "kb-1",
      sourceId: "source-1",
      vectorBackend: "native" as const,
      store,
      contentHash: "sha256:guide",
    }
    const first = await persistKnowledgeBaseChunks({
      ...base,
      chunks: [chunk],
      embeddings: [[0.1, 0.2]],
    })
    store.addDocuments.mockRejectedValueOnce(new Error("remote down"))

    await expect(
      persistKnowledgeBaseChunks({
        ...base,
        contentHash: "sha256:updated",
        chunks: [{ ...chunk, content: "updated", contentRedacted: "updated" }],
        embeddings: [[0.3, 0.4]],
      })
    ).rejects.toThrow("remote down")
    expect(await listKnowledgeBaseChunks("kb-1")).toEqual([
      expect.objectContaining({ generationId: first.generationId, content: chunk.content }),
    ])
  })
})
