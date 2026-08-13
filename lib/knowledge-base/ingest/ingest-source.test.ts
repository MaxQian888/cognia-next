jest.mock("@cognia/vector/embedding", () => ({
  generateEmbeddings: jest.fn(),
}))

import { generateEmbeddings } from "@cognia/vector/embedding"
import type { IVectorStore, VectorDocument } from "@cognia/vector/store"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  createKnowledgeBase,
  createKnowledgeBaseSource,
  listKnowledgeBaseChunks,
  listKnowledgeBaseIngestJobs,
  listKnowledgeBaseSources,
  listKnowledgeBases,
} from "@/lib/db/knowledge-bases"
import { __resetTwinEmbeddingCache } from "@/lib/twin/ingest/embed"
import type { ParsedSource, RawSource } from "@/lib/twin/ingest/parse"
import {
  ingestKnowledgeBaseSource,
  rebuildKnowledgeBaseIndex,
  removeKnowledgeBase,
  removeKnowledgeBaseSource,
} from "./ingest-source"

const dbFixture = createDbTestFixture({
  emptyTables: [
    "knowledgeBases",
    "knowledgeBaseSources",
    "knowledgeBaseChunks",
    "knowledgeBaseIngestJobs",
  ],
})
const generateEmbeddingsMock = generateEmbeddings as jest.Mock

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetTwinEmbeddingCache()
  generateEmbeddingsMock.mockReset()
})
afterAll(dbFixture.dispose)

function createStore(initialDimension?: number) {
  const documents = new Map<string, VectorDocument>()
  const dimensions = new Map<string, number>()
  if (initialDimension !== undefined) dimensions.set("cognia_kb_kb-1", initialDimension)
  return {
    provider: "native",
    documents,
    getCollectionInfo: jest.fn(async (collection: string) => {
      const dimension = dimensions.get(collection)
      if (dimension === undefined) throw new Error("missing")
      return { name: collection, documentCount: documents.size, dimension }
    }),
    createCollection: jest.fn(async (collection: string, options?: { dimension?: number }) => {
      if (options?.dimension !== undefined) dimensions.set(collection, options.dimension)
    }),
    deleteCollection: jest.fn(async (collection: string) => {
      dimensions.delete(collection)
      documents.clear()
    }),
    addDocuments: jest.fn(async (_collection: string, rows: VectorDocument[]) => {
      for (const row of rows) documents.set(row.id, row)
    }),
    deleteDocuments: jest.fn(async (_collection: string, ids: string[]) => {
      for (const id of ids) documents.delete(id)
    }),
  } as unknown as IVectorStore & { documents: Map<string, VectorDocument> }
}

async function seedSource(content = "Contact Alice at alice@example.com for launch details") {
  await createKnowledgeBase({ id: "kb-1", name: "Product", now: 1 })
  return createKnowledgeBaseSource({
    id: "source-1",
    knowledgeBaseId: "kb-1",
    kind: "document",
    format: "markdown",
    title: "Launch guide.md",
    content,
    fingerprint: "sha256:launch",
    now: 2,
  })
}

const embedding = {
  provider: "openai" as const,
  model: "text-embedding-3-small",
  apiKey: "test-key",
}

describe("ingestKnowledgeBaseSource", () => {
  it("parses, redacts, chunks, embeds, persists, and completes its durable job", async () => {
    await seedSource()
    const store = createStore()
    generateEmbeddingsMock.mockImplementation(async (texts) => ({
      embeddings: texts.map(() => [0.1, 0.2]),
      usage: { tokens: 12 },
    }))

    const result = await ingestKnowledgeBaseSource({
      sourceId: "source-1",
      deps: { store, embedding, vectorBackend: "qdrant" },
    })

    expect(result).toEqual(
      expect.objectContaining({ status: "completed", chunkCount: 1, tokensUsed: 12 })
    )
    const embeddedTexts = generateEmbeddingsMock.mock.calls[0][0]
    expect(embeddedTexts.join(" ")).not.toContain("alice@example.com")
    expect([...store.documents.values()][0].content).not.toContain("alice@example.com")
    expect(await listKnowledgeBaseChunks("kb-1")).toEqual([
      expect.objectContaining({
        knowledgeBaseId: "kb-1",
        sourceId: "source-1",
        content: expect.stringContaining("alice@example.com"),
        contentRedacted: expect.not.stringContaining("alice@example.com"),
      }),
    ])
    expect(await listKnowledgeBaseSources("kb-1")).toEqual([
      expect.objectContaining({ status: "ready", chunkCount: 1, errorCode: undefined }),
    ])
    expect(await listKnowledgeBaseIngestJobs("kb-1")).toEqual([
      expect.objectContaining({
        id: result.jobId,
        status: "completed",
        phase: "completed",
        progress: 100,
        attempts: 1,
      }),
    ])
  })

  it("keeps original text for a fully local embedding backend", async () => {
    await seedSource()
    generateEmbeddingsMock.mockImplementation(async (texts) => ({
      embeddings: texts.map(() => [0.1, 0.2]),
    }))

    await ingestKnowledgeBaseSource({
      sourceId: "source-1",
      deps: { store: createStore(), embedding, vectorBackend: "native" },
    })

    expect(generateEmbeddingsMock.mock.calls[0][0].join(" ")).toContain("alice@example.com")
  })

  it("records a bounded rebuild-required failure without persisting source content", async () => {
    await seedSource()
    generateEmbeddingsMock.mockImplementation(async (texts) => ({
      embeddings: texts.map(() => [0.1, 0.2]),
    }))

    await expect(
      ingestKnowledgeBaseSource({
        sourceId: "source-1",
        deps: { store: createStore(3), embedding, vectorBackend: "qdrant" },
      })
    ).rejects.toMatchObject({ name: "EmbeddingDimensionMismatchError" })

    const [source] = await listKnowledgeBaseSources("kb-1")
    const [job] = await listKnowledgeBaseIngestJobs("kb-1")
    expect(source).toEqual(
      expect.objectContaining({ status: "failed", errorCode: "embedding_dimension_mismatch" })
    )
    expect(job).toEqual(
      expect.objectContaining({
        status: "failed",
        phase: "failed",
        errorCode: "embedding_dimension_mismatch",
      })
    )
    expect(
      JSON.stringify({ sourceError: source.errorCode, jobError: job.errorCode })
    ).not.toContain("alice@example.com")
  })

  it("cancels before outbound work and preserves the source's prior state", async () => {
    await seedSource()
    const controller = new AbortController()
    controller.abort()

    const result = await ingestKnowledgeBaseSource({
      sourceId: "source-1",
      deps: { store: createStore(), embedding, vectorBackend: "qdrant" },
      signal: controller.signal,
    })

    expect(result).toEqual(
      expect.objectContaining({ status: "cancelled", chunkCount: 0, tokensUsed: 0 })
    )
    expect(generateEmbeddings).not.toHaveBeenCalled()
    expect(await listKnowledgeBaseSources("kb-1")).toEqual([
      expect.objectContaining({ status: "pending", chunkCount: 0 }),
    ])
    expect(await listKnowledgeBaseIngestJobs("kb-1")).toEqual([
      expect.objectContaining({ status: "cancelled", phase: "cancelled", progress: 0 }),
    ])
  })

  it("removes remote vectors and all locally owned source data", async () => {
    await seedSource()
    const store = createStore()
    generateEmbeddingsMock.mockImplementation(async (texts) => ({
      embeddings: texts.map(() => [0.1, 0.2]),
    }))
    await ingestKnowledgeBaseSource({
      sourceId: "source-1",
      deps: { store, embedding, vectorBackend: "native" },
    })

    await removeKnowledgeBaseSource("source-1", { store })

    expect(store.documents.size).toBe(0)
    expect(await listKnowledgeBaseSources("kb-1")).toEqual([])
    expect(await listKnowledgeBaseChunks("kb-1")).toEqual([])
    expect(await listKnowledgeBaseIngestJobs("kb-1")).toEqual([])
  })

  it("rebuilds an incompatible library collection and re-ingests its sources", async () => {
    await seedSource()
    const store = createStore(3)
    generateEmbeddingsMock.mockImplementation(async (texts) => ({
      embeddings: texts.map(() => [0.1, 0.2]),
    }))
    await expect(
      ingestKnowledgeBaseSource({
        sourceId: "source-1",
        deps: { store, embedding, vectorBackend: "qdrant" },
      })
    ).rejects.toMatchObject({ name: "EmbeddingDimensionMismatchError" })

    const result = await rebuildKnowledgeBaseIndex("kb-1", {
      store,
      embedding,
      vectorBackend: "qdrant",
    })

    expect(result).toEqual({ completedSourceIds: ["source-1"], failedSourceIds: [] })
    expect(store.deleteCollection).not.toHaveBeenCalled()
    expect(store.createCollection).toHaveBeenCalledWith(
      expect.stringMatching(/^cognia_kb_kb-1__rebuild_/),
      { dimension: 2 }
    )
    const [rebuiltSource] = await listKnowledgeBaseSources("kb-1")
    expect(rebuiltSource).toEqual(expect.objectContaining({ status: "ready", chunkCount: 1 }))
    expect(rebuiltSource.errorCode).toBeUndefined()
  })

  it("persists a bounded stage code when parsing fails", async () => {
    await seedSource()
    const parse = jest.fn(async (_raw: RawSource): Promise<ParsedSource> => {
      throw new Error("malformed source body")
    })

    await expect(
      ingestKnowledgeBaseSource({
        sourceId: "source-1",
        deps: { store: createStore(), embedding, vectorBackend: "native" },
        parse,
      })
    ).rejects.toThrow("malformed source body")

    expect(await listKnowledgeBaseSources("kb-1")).toEqual([
      expect.objectContaining({ status: "failed", errorCode: "parsing_failed" }),
    ])
    expect(await listKnowledgeBaseIngestJobs("kb-1")).toEqual([
      expect.objectContaining({ status: "failed", errorCode: "parsing_failed" }),
    ])
  })

  it("decodes durable base64 document content before parsing", async () => {
    await createKnowledgeBase({ id: "kb-1", name: "Product", now: 1 })
    await createKnowledgeBaseSource({
      id: "source-1",
      knowledgeBaseId: "kb-1",
      kind: "document",
      format: "pdf",
      title: "guide.pdf",
      content: globalThis.btoa("binary-pdf"),
      contentEncoding: "base64",
      bytes: 10,
      fingerprint: "pdf-hash",
      now: 2,
    })
    const parse = jest.fn(async (_raw: RawSource): Promise<ParsedSource> => ({
      id: "source-1",
      kind: "document",
      format: "pdf",
      title: "guide.pdf",
      originalText: "Parsed PDF content",
      embeddableText: "Parsed PDF content",
      baseMetadata: {},
      bytes: 10,
    }))
    generateEmbeddingsMock.mockResolvedValue({ embeddings: [[0.1, 0.2]] })

    await ingestKnowledgeBaseSource({
      sourceId: "source-1",
      deps: { store: createStore(), embedding, vectorBackend: "native" },
      parse,
    })

    expect(parse).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "guide.pdf",
        format: "pdf",
        binary: expect.any(Uint8Array),
      })
    )
    expect(new TextDecoder().decode(parse.mock.calls[0][0].binary)).toBe("binary-pdf")
  })

  it("reports per-source failures while rebuilding the remaining sources", async () => {
    await seedSource("Healthy source")
    await createKnowledgeBaseSource({
      id: "source-2",
      knowledgeBaseId: "kb-1",
      kind: "document",
      format: "markdown",
      title: "Broken",
      content: "Broken source",
      fingerprint: "broken",
      now: 3,
    })
    generateEmbeddingsMock.mockImplementation(async (texts) => {
      if (texts.join(" ").includes("Broken")) throw new Error("embedding unavailable")
      return { embeddings: texts.map(() => [0.1, 0.2]) }
    })

    const result = await rebuildKnowledgeBaseIndex("kb-1", {
      store: createStore(),
      embedding,
      vectorBackend: "native",
    })

    expect(result).toEqual({ completedSourceIds: ["source-1"], failedSourceIds: ["source-2"] })
  })

  it("rejects an unknown source without creating a job", async () => {
    await expect(
      ingestKnowledgeBaseSource({
        sourceId: "missing",
        deps: { store: createStore(), embedding, vectorBackend: "native" },
      })
    ).rejects.toThrow("source not found")
  })

  it("honors cancellation after parsing and restores the prior source state", async () => {
    await seedSource()
    const controller = new AbortController()
    const parse = jest.fn(async (_raw: RawSource): Promise<ParsedSource> => {
      controller.abort()
      return {
        id: "source-1",
        kind: "document" as const,
        format: "markdown" as const,
        title: "Guide",
        originalText: "content",
        embeddableText: "content",
        baseMetadata: {},
        bytes: 7,
      }
    })

    const result = await ingestKnowledgeBaseSource({
      sourceId: "source-1",
      deps: { store: createStore(), embedding, vectorBackend: "native" },
      signal: controller.signal,
      parse,
    })

    expect(result.status).toBe("cancelled")
    expect(generateEmbeddings).not.toHaveBeenCalled()
    expect(await listKnowledgeBaseSources("kb-1")).toEqual([
      expect.objectContaining({ status: "pending" }),
    ])
  })

  it("keeps local deletion authoritative when remote vector cleanup fails or is unavailable", async () => {
    await seedSource()
    generateEmbeddingsMock.mockResolvedValue({ embeddings: [[0.1, 0.2]] })
    const store = createStore()
    await ingestKnowledgeBaseSource({
      sourceId: "source-1",
      deps: { store, embedding, vectorBackend: "native" },
    })
    jest.mocked(store.deleteDocuments).mockRejectedValueOnce(new Error("remote unavailable"))

    await removeKnowledgeBaseSource("source-1", { store })
    await expect(removeKnowledgeBaseSource("already-removed")).resolves.toBeUndefined()
    expect(await listKnowledgeBaseSources("kb-1")).toEqual([])
  })

  it("rebuilds an empty library without scheduling source jobs", async () => {
    await createKnowledgeBase({ id: "kb-1", name: "Empty", now: 1 })
    const result = await rebuildKnowledgeBaseIndex("kb-1", {
      store: createStore(),
      embedding,
      vectorBackend: "native",
    })
    expect(result).toEqual({ completedSourceIds: [], failedSourceIds: [] })
  })

  it("translates PDF page provenance through cloud redaction", async () => {
    await seedSource()
    const text = "Email alice@example.com for details"
    const parse = jest.fn(async (_raw: RawSource): Promise<ParsedSource> => ({
      id: "source-1",
      kind: "document" as const,
      format: "pdf" as const,
      title: "Guide",
      originalText: text,
      embeddableText: text,
      baseMetadata: {},
      bytes: text.length,
      pageMap: [{ pageNumber: 1, charStart: 0, charEnd: text.length }],
    }))
    generateEmbeddingsMock.mockResolvedValue({ embeddings: [[0.1, 0.2]] })

    await ingestKnowledgeBaseSource({
      sourceId: "source-1",
      deps: { store: createStore(), embedding, vectorBackend: "qdrant" },
      parse,
    })

    expect(await listKnowledgeBaseChunks("kb-1")).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ pageNumber: 1 }) }),
    ])
  })

  it("deletes a whole reusable library and its remote vector collection", async () => {
    await seedSource()
    const store = createStore()
    generateEmbeddingsMock.mockResolvedValue({ embeddings: [[0.1, 0.2]] })
    await ingestKnowledgeBaseSource({
      sourceId: "source-1",
      deps: { store, embedding, vectorBackend: "native" },
    })

    await removeKnowledgeBase("kb-1", { deps: { store } })

    expect(store.deleteCollection).toHaveBeenCalledWith("cognia_kb_kb-1")
    expect(await listKnowledgeBases()).toEqual([])
  })

  it("keeps the remote collection when the library deletion guard blocks references", async () => {
    await seedSource()
    await getDb().characters.put({
      id: "agent-1",
      name: "Research Agent",
      systemPrompt: "Research",
      avatarColor: "blue",
      knowledgeBaseIds: ["kb-1"],
      createdAt: 1,
      updatedAt: 1,
    })
    const store = createStore()

    await expect(removeKnowledgeBase("kb-1", { deps: { store } })).rejects.toMatchObject({
      code: "knowledge_base_in_use",
    })

    expect(store.deleteCollection).not.toHaveBeenCalled()
    expect(await listKnowledgeBases()).toHaveLength(1)
  })

  it("keeps local deletion authoritative when remote collection cleanup fails", async () => {
    await seedSource()
    const store = createStore()
    jest.mocked(store.deleteCollection).mockRejectedValueOnce(new Error("remote unavailable"))

    await removeKnowledgeBase("kb-1", { deps: { store } })

    expect(await listKnowledgeBases()).toEqual([])
  })

  it.each([
    ["redaction", 2],
    ["chunking", 3],
    ["embedding", 4],
  ])("honors cancellation after %s", async (_stage, abortRead) => {
    await seedSource("Cancellation boundary content")
    generateEmbeddingsMock.mockResolvedValue({ embeddings: [[0.1, 0.2]] })
    let reads = 0
    const signal = {
      get aborted() {
        return reads++ === abortRead
      },
    } as AbortSignal

    const result = await ingestKnowledgeBaseSource({
      sourceId: "source-1",
      deps: { store: createStore(), embedding, vectorBackend: "native" },
      signal,
    })

    expect(result.status).toBe("cancelled")
    expect(await listKnowledgeBaseSources("kb-1")).toEqual([
      expect.objectContaining({ status: "pending" }),
    ])
  })
})
