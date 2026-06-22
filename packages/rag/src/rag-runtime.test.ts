jest.mock("./rag-pipeline", () => ({
  createRAGPipeline: jest.fn(),
}))

import {
  createRAGRuntime,
  createRAGRuntimeConfigFromVectorSettings,
  getSharedRAGRuntime,
  resolveSharedRAGRuntimeSelection,
  resetSharedRAGRuntimes,
} from "./rag-runtime"
import { createRAGPipeline } from "./rag-pipeline"
import {
  resetStorageBackendReadinessRegistryForTest,
  updateStorageBackendReadiness,
} from "./runtime-adapters"

const mockCreateRAGPipeline = jest.mocked(createRAGPipeline)

function createMockPipeline() {
  return {
    indexDocument: jest.fn().mockResolvedValue({ chunksCreated: 2, success: true }),
    retrieve: jest.fn().mockResolvedValue({ context: "retrieved" }),
    deleteDocuments: jest.fn().mockResolvedValue(2),
    deleteByDocumentId: jest.fn().mockResolvedValue(1),
    clearCollection: jest.fn().mockResolvedValue(undefined),
    getCollectionStats: jest.fn().mockResolvedValue({ documentCount: 3, exists: true }),
  }
}

describe("createRAGRuntimeConfigFromVectorSettings", () => {
  beforeEach(() => {
    resetStorageBackendReadinessRegistryForTest()
    resetSharedRAGRuntimes()
    mockCreateRAGPipeline.mockReset()
  })

  it("preserves milvus-specific connection settings", () => {
    const runtimeConfig = createRAGRuntimeConfigFromVectorSettings(
      {
        provider: "milvus",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        milvusAddress: "https://milvus.example.com:19530",
        milvusToken: "milvus-token",
        milvusUsername: "milvus-user",
        milvusPassword: "milvus-password",
        milvusSsl: true,
      },
      "embedding-key"
    )

    expect(runtimeConfig.vectorStore).toEqual(
      expect.objectContaining({
        provider: "milvus",
        milvusAddress: "https://milvus.example.com:19530",
        milvusToken: "milvus-token",
        milvusUsername: "milvus-user",
        milvusPassword: "milvus-password",
        milvusSsl: true,
      })
    )
  })

  it("treats complete settings as usable when no blocking readiness record exists", () => {
    const selection = resolveSharedRAGRuntimeSelection(
      {
        provider: "qdrant",
        qdrantUrl: "https://qdrant.example.com",
        qdrantApiKey: "qdrant-key",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
      },
      "embedding-key"
    )

    expect(selection.usable).toBe(true)
    expect(selection.degradeReason).toBe("none")
    expect(selection.runtimeConfig?.vectorStore).toEqual(
      expect.objectContaining({
        provider: "qdrant",
        qdrantUrl: "https://qdrant.example.com",
        qdrantApiKey: "qdrant-key",
      })
    )
  })

  it("returns an explicit fallback reason when readiness marks the provider degraded", () => {
    updateStorageBackendReadiness({
      id: "vector-qdrant",
      state: "degraded",
      lastCheckedAt: "2026-03-19T10:30:00.000Z",
      diagnostic: {
        code: "roundtrip-failed",
        message: "Qdrant readiness failed",
        at: "2026-03-19T10:30:00.000Z",
        stage: "operational",
      },
    })

    const selection = resolveSharedRAGRuntimeSelection(
      {
        provider: "qdrant",
        qdrantUrl: "https://qdrant.example.com",
        qdrantApiKey: "qdrant-key",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
      },
      "embedding-key"
    )

    expect(selection.usable).toBe(false)
    expect(selection.degradeReason).toBe("runtime_error")
    expect(selection.readiness?.state).toBe("degraded")
  })

  it("applies defaults and optional RAG feature settings", () => {
    const runtimeConfig = createRAGRuntimeConfigFromVectorSettings(
      {
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        defaultCollectionName: "",
        ragTopK: 9,
        ragSimilarityThreshold: 0.72,
        ragMaxContextLength: 12000,
        enableHybridSearch: true,
        vectorWeight: 0.55,
        keywordWeight: 0.45,
        enableReranking: true,
        enableQueryExpansion: true,
        enableCitations: true,
        citationStyle: "apa",
      },
      "embedding-key"
    )

    expect(runtimeConfig).toMatchObject({
      defaultCollectionName: "default",
      topK: 9,
      similarityThreshold: 0.72,
      maxContextLength: 12000,
      hybridSearch: { enabled: true, vectorWeight: 0.55, keywordWeight: 0.45 },
      reranking: { enabled: true },
      queryExpansion: { enabled: true },
      citations: { enabled: true, style: "apa" },
      vectorStore: {
        provider: "chroma",
        chromaMode: "embedded",
        embeddingApiKey: "embedding-key",
        embeddingConfig: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    })
  })

  it("marks incomplete provider runtime settings as not configured", () => {
    const base = {
      embeddingProvider: "openai" as const,
      embeddingModel: "text-embedding-3-small",
    }

    expect(
      resolveSharedRAGRuntimeSelection({ ...base, provider: "chroma", mode: "server" }, "key")
    ).toMatchObject({ usable: false, provider: "chroma", degradeReason: "not_configured" })
    expect(
      resolveSharedRAGRuntimeSelection({ ...base, provider: "pinecone" }, "key")
    ).toMatchObject({ usable: false, provider: "pinecone", degradeReason: "not_configured" })
    expect(
      resolveSharedRAGRuntimeSelection({ ...base, provider: "weaviate" }, "key")
    ).toMatchObject({ usable: false, provider: "weaviate", degradeReason: "not_configured" })
    expect(resolveSharedRAGRuntimeSelection({ ...base, provider: "qdrant" }, "key")).toMatchObject({
      usable: false,
      provider: "qdrant",
      degradeReason: "not_configured",
    })
    expect(resolveSharedRAGRuntimeSelection({ ...base, provider: "milvus" }, "key")).toMatchObject({
      usable: false,
      provider: "milvus",
      degradeReason: "not_configured",
    })
    expect(resolveSharedRAGRuntimeSelection({ ...base, provider: "native" }, "")).toMatchObject({
      usable: false,
      provider: "native",
      degradeReason: "not_configured",
    })
  })

  it("maps operational and unconfigured readiness records to selection results", () => {
    updateStorageBackendReadiness({
      id: "vector-chroma",
      state: "operational",
      lastCheckedAt: "2026-03-19T10:30:00.000Z",
    })

    expect(
      resolveSharedRAGRuntimeSelection(
        {
          provider: "chroma",
          mode: "server",
          serverUrl: "https://chroma.example.com",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
        },
        "embedding-key"
      )
    ).toMatchObject({ usable: true, provider: "chroma", degradeReason: "none" })

    updateStorageBackendReadiness({
      id: "vector-chroma",
      state: "unconfigured",
      lastCheckedAt: "2026-03-19T10:31:00.000Z",
      diagnostic: {
        code: "configuration-missing",
        message: "Missing config",
        at: "2026-03-19T10:31:00.000Z",
      },
    })

    expect(
      resolveSharedRAGRuntimeSelection(
        {
          provider: "chroma",
          mode: "server",
          serverUrl: "https://chroma.example.com",
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
        },
        "embedding-key"
      )
    ).toMatchObject({ usable: false, provider: "chroma", degradeReason: "not_configured" })
  })
})

describe("RAGRuntime lifecycle", () => {
  const runtimeConfig = createRAGRuntimeConfigFromVectorSettings(
    {
      provider: "native",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      defaultCollectionName: "knowledge",
    },
    "embedding-key"
  )

  beforeEach(() => {
    resetSharedRAGRuntimes()
    mockCreateRAGPipeline.mockReset()
  })

  it("delegates runtime methods to the current pipeline and uses default collections", async () => {
    const pipeline = createMockPipeline()
    mockCreateRAGPipeline.mockReturnValue(pipeline as never)

    const runtime = createRAGRuntime(runtimeConfig)

    expect(runtime.getConfig()).toBe(runtimeConfig)
    await expect(
      runtime.indexDocument("content", { collectionName: "knowledge", documentId: "doc-1" })
    ).resolves.toEqual({
      chunksCreated: 2,
      success: true,
    })
    await expect(runtime.retrieve("docs", "query")).resolves.toEqual({ context: "retrieved" })
    await expect(runtime.retrieveDefault("query")).resolves.toEqual({ context: "retrieved" })
    await expect(runtime.deleteDocuments("docs", ["a", "b"])).resolves.toBe(2)
    await expect(runtime.deleteByDocumentId("docs", "source-1")).resolves.toBe(1)
    await expect(runtime.clearCollection("docs")).resolves.toBeUndefined()
    await expect(runtime.getCollectionStats("docs")).resolves.toEqual({
      documentCount: 3,
      exists: true,
    })
    expect(runtime.getPipeline()).toBe(pipeline)
    expect(pipeline.retrieve).toHaveBeenCalledWith("knowledge", "query")
  })

  it("rebuilds the pipeline when configuration changes", () => {
    const firstPipeline = createMockPipeline()
    const secondPipeline = createMockPipeline()
    mockCreateRAGPipeline
      .mockReturnValueOnce(firstPipeline as never)
      .mockReturnValueOnce(secondPipeline as never)

    const runtime = createRAGRuntime(runtimeConfig)
    runtime.updateConfig({
      topK: 12,
      vectorStore: {
        provider: "native",
        embeddingConfig: { provider: "openai", model: "text-embedding-3-large" },
        embeddingApiKey: "new-key",
        native: {},
      },
    })

    expect(runtime.getPipeline()).toBe(secondPipeline)
    expect(runtime.getConfig()).toMatchObject({
      topK: 12,
      vectorStore: {
        provider: "native",
        embeddingApiKey: "new-key",
        embeddingConfig: { provider: "openai", model: "text-embedding-3-large" },
      },
    })
    expect(mockCreateRAGPipeline).toHaveBeenCalledTimes(2)
  })

  it("caches shared runtimes by config hash and resets the shared registry", () => {
    mockCreateRAGPipeline.mockImplementation(() => createMockPipeline() as never)

    const first = getSharedRAGRuntime("project-a", runtimeConfig)
    const again = getSharedRAGRuntime("project-a", runtimeConfig)
    const changed = getSharedRAGRuntime("project-a", { ...runtimeConfig, topK: 99 })

    expect(again).toBe(first)
    expect(changed).not.toBe(first)

    resetSharedRAGRuntimes()
    const afterReset = getSharedRAGRuntime("project-a", runtimeConfig)
    expect(afterReset).not.toBe(changed)
  })
})
