/** @jest-environment jsdom */
import {
  ChromaVectorStore,
  MilvusVectorStore,
  createVectorStore,
  getSupportedVectorStoreProviders,
  NativeVectorStore,
  PineconeVectorStore,
  QdrantVectorStore,
  type VectorStoreConfig,
  type VectorDocument,
  type PayloadFilter,
  type CollectionImport,
  WeaviateVectorStore,
} from "./store"

const mockEmbeddingConfig = {
  provider: "openai" as const,
  model: "text-embedding-3-small",
  dimensions: 1536,
}

const mockConfig: VectorStoreConfig = {
  provider: "native",
  embeddingConfig: mockEmbeddingConfig,
  embeddingApiKey: "test-api-key",
  native: {},
}

// Mock Tauri invoke function. Canonical jest pattern — the factory uses
// only literal `jest.fn()`, and we grab a typed handle afterwards via
// `import` so assertions can target it.
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))
import { invoke as _mockedInvoke } from "@tauri-apps/api/core"
const mockInvoke = _mockedInvoke as jest.MockedFunction<typeof _mockedInvoke>

// Mock window.__TAURI_INTERNALS__ to simulate Tauri environment
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: {},
  writable: true,
  configurable: true, // Allow deletion
})

// Extend Window interface for TypeScript
declare global {
  interface Window {
    __TAURI_INTERNALS__?: Record<string, unknown>
  }
}

// Mock embedding functions
jest.mock("./embedding", () => ({
  generateEmbedding: jest.fn().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3],
    model: "text-embedding-3-small",
    provider: "openai",
  }),
  generateEmbeddings: jest.fn().mockResolvedValue({
    embeddings: [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ],
    model: "text-embedding-3-small",
    provider: "openai",
  }),
}))

jest.mock("./invoke", () => ({
  vectorCloudInvoke: {
    upsert: jest.fn(),
    deletePoints: jest.fn(),
    truncate: jest.fn(),
    query: jest.fn(),
    getPoints: jest.fn(),
    createCollection: jest.fn(),
    deleteCollection: jest.fn(),
    listCollections: jest.fn(),
    getCollection: jest.fn(),
    count: jest.fn(),
  },
}))

// Get the mocked functions after the module is mocked
import * as embeddingModule from "./embedding"
const mockGenerateEmbedding = jest.mocked(embeddingModule.generateEmbedding)
const mockGenerateEmbeddings = jest.mocked(embeddingModule.generateEmbeddings)

import { vectorCloudInvoke } from "./invoke"
const mockVectorCloudInvoke = vectorCloudInvoke as unknown as {
  upsert: jest.Mock
  deletePoints: jest.Mock
  truncate: jest.Mock
  query: jest.Mock
  getPoints: jest.Mock
  createCollection: jest.Mock
  deleteCollection: jest.Mock
  listCollections: jest.Mock
  getCollection: jest.Mock
  count: jest.Mock
}

describe("createVectorStore factory", () => {
  it("creates native vector store when provider is native", () => {
    const store = createVectorStore(mockConfig)
    expect(store.provider).toBe("native")
    expect(store).toBeInstanceOf(NativeVectorStore)
  })

  it("throws on unsupported provider", () => {
    // @ts-expect-error - testing invalid provider
    expect(() => createVectorStore({ ...mockConfig, provider: "unknown" })).toThrow(
      "Unsupported vector store provider: unknown"
    )
  })

  it("creates each configured cloud provider and lists supported providers", () => {
    expect(
      createVectorStore({
        ...mockConfig,
        provider: "chroma",
        configId: "chroma-config",
      })
    ).toBeInstanceOf(ChromaVectorStore)
    expect(
      createVectorStore({
        ...mockConfig,
        provider: "pinecone",
        configId: "pinecone-config",
        pineconeApiKey: "pk",
        pineconeIndexName: "idx",
      })
    ).toBeInstanceOf(PineconeVectorStore)
    expect(
      createVectorStore({
        ...mockConfig,
        provider: "weaviate",
        configId: "weaviate-config",
        weaviateUrl: "http://weaviate",
      })
    ).toBeInstanceOf(WeaviateVectorStore)
    expect(
      createVectorStore({
        ...mockConfig,
        provider: "qdrant",
        configId: "qdrant-config",
        qdrantUrl: "http://qdrant",
      })
    ).toBeInstanceOf(QdrantVectorStore)
    expect(
      createVectorStore({
        ...mockConfig,
        provider: "milvus",
        configId: "milvus-config",
        milvusAddress: "localhost:19530",
      })
    ).toBeInstanceOf(MilvusVectorStore)
    expect(getSupportedVectorStoreProviders()).toEqual([
      "chroma",
      "pinecone",
      "qdrant",
      "milvus",
      "native",
      "weaviate",
    ])
  })
})

describe("createVectorStore plugin-event proxy", () => {
  it("dispatches onDocumentsIndexed after addDocuments resolves", async () => {
    mockInvoke.mockResolvedValue(true)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPluginEventHooks } = require("@/lib/plugin/messaging/hooks-system") as {
      getPluginEventHooks: () => {
        dispatchDocumentsIndexed: (collection: string, count: number) => void
        dispatchVectorSearch: (collection: string, query: string, count: number) => void
      }
    }
    const indexedSpy = jest
      .spyOn(getPluginEventHooks(), "dispatchDocumentsIndexed")
      .mockImplementation(() => {})

    const store = createVectorStore(mockConfig)
    const docs: VectorDocument[] = [
      { id: "a", content: "hello", embedding: [0.1, 0.2, 0.3] },
      { id: "b", content: "world", embedding: [0.4, 0.5, 0.6] },
    ]
    await store.addDocuments("plugins-test", docs)
    expect(indexedSpy).toHaveBeenCalledWith("plugins-test", 2)
  })

  it("dispatches onVectorSearch after searchDocuments resolves", async () => {
    mockInvoke.mockResolvedValue({ results: [], total: 0 })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPluginEventHooks } = require("@/lib/plugin/messaging/hooks-system") as {
      getPluginEventHooks: () => {
        dispatchDocumentsIndexed: (collection: string, count: number) => void
        dispatchVectorSearch: (collection: string, query: string, count: number) => void
      }
    }
    const searchSpy = jest
      .spyOn(getPluginEventHooks(), "dispatchVectorSearch")
      .mockImplementation(() => {})

    const store = createVectorStore(mockConfig)
    const results = await store.searchDocuments("plugins-test", "hello")
    expect(searchSpy).toHaveBeenCalledWith("plugins-test", "hello", results.length)
  })
})

describe("CloudVectorStore", () => {
  const cloudConfig: VectorStoreConfig = {
    ...mockConfig,
    provider: "chroma",
    configId: "credential-1",
  }

  let store: ChromaVectorStore

  beforeEach(() => {
    store = new ChromaVectorStore(cloudConfig)
    Object.values(mockVectorCloudInvoke).forEach((mock) => mock.mockReset())
    mockGenerateEmbedding.mockReset()
    mockGenerateEmbeddings.mockReset()
    mockGenerateEmbedding.mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
      model: "test-model",
      provider: "openai",
    })
    mockGenerateEmbeddings.mockResolvedValue({
      embeddings: [[0.7, 0.8, 0.9]],
      model: "test-model",
      provider: "openai",
    })
  })

  it("requires config ids for cloud providers and validates factory-specific provider fields", () => {
    expect(() => new ChromaVectorStore({ ...cloudConfig, configId: undefined })).toThrow(
      "requires config.configId"
    )
    expect(() =>
      createVectorStore({ ...cloudConfig, provider: "pinecone", pineconeApiKey: undefined })
    ).toThrow("Pinecone API key is required")
    expect(() =>
      createVectorStore({
        ...cloudConfig,
        provider: "pinecone",
        pineconeApiKey: "pk",
        pineconeIndexName: undefined,
      })
    ).toThrow("Pinecone index name is required")
    expect(() => createVectorStore({ ...cloudConfig, provider: "weaviate" })).toThrow(
      "Weaviate URL is required"
    )
    expect(() => createVectorStore({ ...cloudConfig, provider: "qdrant" })).toThrow(
      "Qdrant URL is required"
    )
    expect(() => createVectorStore({ ...cloudConfig, provider: "milvus" })).toThrow(
      "Milvus address is required"
    )
  })

  it("adds, updates, deletes, and truncates documents through vectorCloudInvoke", async () => {
    mockVectorCloudInvoke.upsert.mockResolvedValue(undefined)
    mockVectorCloudInvoke.deletePoints.mockResolvedValue(undefined)
    mockVectorCloudInvoke.truncate.mockResolvedValue(3)

    await store.addDocuments("cloud-col", [
      { id: "a", content: "needs embedding", metadata: { tag: "a" } },
      { id: "b", content: "has embedding", embedding: [0.4, 0.5, 0.6] },
    ])
    await store.updateDocuments("cloud-col", [
      { id: "c", content: "updated", embedding: [0.2, 0.2, 0.2] },
    ])
    await store.deleteDocuments("cloud-col", ["a"])
    await expect(store.deleteAllDocuments("cloud-col")).resolves.toBe(3)

    expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
      ["needs embedding"],
      mockEmbeddingConfig,
      "test-api-key"
    )
    expect(mockVectorCloudInvoke.upsert).toHaveBeenNthCalledWith(
      1,
      { provider: "chroma", configId: "credential-1" },
      "cloud-col",
      [
        { id: "a", vector: [0.7, 0.8, 0.9], payload: { tag: "a", content: "needs embedding" } },
        { id: "b", vector: [0.4, 0.5, 0.6], payload: { content: "has embedding" } },
      ]
    )
    expect(mockVectorCloudInvoke.deletePoints).toHaveBeenCalledWith(
      { provider: "chroma", configId: "credential-1" },
      "cloud-col",
      ["a"]
    )
    expect(mockVectorCloudInvoke.truncate).toHaveBeenCalledWith(
      { provider: "chroma", configId: "credential-1" },
      "cloud-col"
    )
  })

  it("adds documents without generating embeddings when every document already has one", async () => {
    mockVectorCloudInvoke.upsert.mockResolvedValue(undefined)

    await store.addDocuments("cloud-col", [
      { id: "a", content: "embedded a", embedding: [0.1, 0.2, 0.3] },
      { id: "b", content: "embedded b", embedding: [0.4, 0.5, 0.6] },
    ])

    expect(mockGenerateEmbeddings).not.toHaveBeenCalled()
    expect(mockVectorCloudInvoke.upsert).toHaveBeenCalledWith(
      { provider: "chroma", configId: "credential-1" },
      "cloud-col",
      [
        { id: "a", vector: [0.1, 0.2, 0.3], payload: { content: "embedded a" } },
        { id: "b", vector: [0.4, 0.5, 0.6], payload: { content: "embedded b" } },
      ]
    )
  })

  it("searches cloud documents by query and embedding with unified post filters", async () => {
    mockVectorCloudInvoke.query.mockResolvedValue({
      results: [
        {
          id: "a",
          content: undefined,
          payload: {
            content: "alpha text",
            title: "Alpha Report",
            tags: ["finance", "north"],
            score: 10,
            status: "active",
            nullable: null,
          },
          score: 0.95,
        },
        {
          id: "b",
          content: "explicit beta",
          payload: {
            title: "Beta Note",
            tags: ["ops"],
            score: 2,
            status: "archived",
            nullable: "value",
          },
          score: 0.4,
        },
      ],
    })

    const results = await store.searchDocuments("cloud-col", "find alpha", {
      topK: 5,
      offset: 0,
      limit: 1,
      threshold: 0.5,
      filters: [
        { key: "tags", value: "finance", operation: "contains" },
        { key: "title", value: "Alpha", operation: "starts_with" },
        { key: "status", value: ["active", "queued"], operation: "in" },
        { key: "nullable", value: null, operation: "is_null" },
      ],
      filterMode: "and",
    })

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      "find alpha",
      mockEmbeddingConfig,
      "test-api-key"
    )
    expect(mockVectorCloudInvoke.query).toHaveBeenCalledWith(
      { provider: "chroma", configId: "credential-1" },
      "cloud-col",
      [0.1, 0.2, 0.3],
      {
        limit: 5,
        offset: 0,
        filter: [
          { key: "tags", value: "finance", operation: "contains" },
          { key: "title", value: "Alpha", operation: "starts_with" },
          { key: "status", value: ["active", "queued"], operation: "in" },
          { key: "nullable", value: null, operation: "is_null" },
        ],
        filter_mode: "and",
        include_payload: true,
        include_content: true,
      }
    )
    expect(results).toEqual([
      {
        id: "a",
        content: "",
        metadata: {
          content: "alpha text",
          title: "Alpha Report",
          tags: ["finance", "north"],
          score: 10,
          status: "active",
          nullable: null,
        },
        score: 0.95,
      },
    ])
  })

  it("evaluates all unified filter operations and OR mode on cloud search results", async () => {
    mockVectorCloudInvoke.query.mockResolvedValue({
      results: [
        {
          id: "a",
          content: "alpha",
          payload: {
            text: "hello world",
            tags: ["x", "y"],
            score: 5,
            rank: "b",
            empty: undefined,
            suffix: "report.md",
            status: "active",
          },
          score: 0.9,
        },
      ],
    })

    const filters: PayloadFilter[] = [
      { key: "text", value: "hello world", operation: "equals" },
      { key: "status", value: "archived", operation: "not_equals" },
      { key: "text", value: "hello", operation: "contains" },
      { key: "tags", value: "z", operation: "not_contains" },
      { key: "score", value: 4, operation: "greater_than" },
      { key: "score", value: 5, operation: "greater_than_or_equals" },
      { key: "rank", value: "c", operation: "less_than" },
      { key: "rank", value: "b", operation: "less_than_or_equals" },
      { key: "empty", value: null, operation: "is_null" },
      { key: "text", value: "hello", operation: "starts_with" },
      { key: "suffix", value: ".md", operation: "ends_with" },
      { key: "status", value: ["active"], operation: "in" },
      { key: "status", value: ["archived"], operation: "not_in" },
    ]

    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], { filters })
    ).resolves.toHaveLength(1)
    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [
          { key: "text", value: "missing", operation: "contains" },
          { key: "status", value: "active", operation: "equals" },
        ],
        filterMode: "or",
      })
    ).resolves.toHaveLength(1)
    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "score", value: "not comparable", operation: "greater_than" }],
      })
    ).resolves.toHaveLength(0)
  })

  it("post-filters unsupported value shapes conservatively", async () => {
    mockVectorCloudInvoke.query.mockResolvedValue({
      results: [
        {
          id: "a",
          content: "alpha",
          payload: {
            numberText: 42,
            list: ["a"],
            status: "active",
          },
          score: 0.9,
        },
      ],
    })

    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "numberText", value: "4", operation: "contains" }],
      })
    ).resolves.toHaveLength(0)
    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "numberText", value: "4", operation: "not_contains" }],
      })
    ).resolves.toHaveLength(1)
    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "numberText", value: "4", operation: "starts_with" }],
      })
    ).resolves.toHaveLength(0)
    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "numberText", value: "2", operation: "ends_with" }],
      })
    ).resolves.toHaveLength(0)
    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "status", value: "active", operation: "in" }],
      })
    ).resolves.toHaveLength(0)
    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "status", value: "archived", operation: "not_in" }],
      })
    ).resolves.toHaveLength(0)
  })

  it("post-filters missing metadata, string comparisons, and unknown operations", async () => {
    mockVectorCloudInvoke.query.mockResolvedValue({
      results: [
        {
          id: "a",
          content: "alpha",
          payload: {
            rank: "b",
            tags: ["x"],
          },
          score: 0.9,
        },
        {
          id: "b",
          content: "beta",
          payload: undefined,
          score: 0.8,
        },
      ],
    })

    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "rank", value: "a", operation: "greater_than" }],
      })
    ).resolves.toHaveLength(1)
    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "rank", value: "b", operation: "greater_than_or_equals" }],
      })
    ).resolves.toHaveLength(1)
    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "tags", value: "x", operation: "not_contains" }],
      })
    ).resolves.toHaveLength(1)
    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "missing", value: null, operation: "is_null" }],
      })
    ).resolves.toHaveLength(2)
    await expect(
      store.searchByEmbedding!("cloud-col", [1, 2, 3], {
        filters: [{ key: "rank", value: "ignored", operation: "unknown" as never }],
      })
    ).resolves.toHaveLength(2)
  })

  it("uses default cloud dimensions and native count success paths", async () => {
    const dimensionless = new ChromaVectorStore({
      ...cloudConfig,
      embeddingConfig: { ...mockEmbeddingConfig, dimensions: undefined },
    })
    mockVectorCloudInvoke.createCollection.mockResolvedValueOnce(undefined)

    await dimensionless.createCollection("default-dim")

    expect(mockVectorCloudInvoke.createCollection).toHaveBeenCalledWith(
      { provider: "chroma", configId: "credential-1" },
      expect.objectContaining({ dimension: 1536 })
    )

    mockVectorCloudInvoke.query.mockResolvedValueOnce({
      results: [{ id: "match", content: "match", payload: { status: "active" }, score: 0.7 }],
    })
    mockVectorCloudInvoke.count.mockResolvedValueOnce(11)

    await expect(store.searchDocumentsWithTotal!("cloud-col", "query")).resolves.toMatchObject({
      total: 11,
      offset: 0,
      limit: 5,
    })
  })

  it("returns cloud collection dimensions when they are known", async () => {
    mockVectorCloudInvoke.getCollection.mockResolvedValueOnce({
      name: "known",
      document_count: 3,
      dimension: 1536,
      description: "Known",
    })

    await expect(store.getCollectionInfo("known")).resolves.toEqual({
      name: "known",
      documentCount: 3,
      dimension: 1536,
      description: "Known",
    })
  })

  it("returns paged totals, documents, collections, and counts for cloud providers", async () => {
    mockVectorCloudInvoke.query.mockResolvedValueOnce({
      results: [
        { id: "a", content: "alpha", payload: { status: "active" }, score: 0.9 },
        { id: "b", content: "beta", payload: { status: "active" }, score: 0.8 },
      ],
    })
    mockVectorCloudInvoke.count.mockRejectedValueOnce(new Error("count unavailable"))

    const total = await store.searchDocumentsWithTotal!("cloud-col", "query", {
      offset: 1,
      limit: 1,
    })

    expect(total).toEqual({
      results: [{ id: "b", content: "beta", metadata: { status: "active" }, score: 0.8 }],
      total: 2,
      offset: 1,
      limit: 1,
    })

    mockVectorCloudInvoke.getPoints.mockResolvedValueOnce([
      { id: "p1", payload: { content: "payload content" }, vector: [0.1] },
      { id: "p2", payload: {}, vector: [] },
    ])
    await expect(store.getDocuments("cloud-col", ["p1", "p2"])).resolves.toEqual([
      {
        id: "p1",
        content: "payload content",
        metadata: { content: "payload content" },
        embedding: [0.1],
      },
      { id: "p2", content: "", metadata: {}, embedding: undefined },
    ])

    mockVectorCloudInvoke.createCollection.mockResolvedValueOnce(undefined)
    await store.createCollection("new-col", { metadata: { owner: "me" } })
    expect(mockVectorCloudInvoke.createCollection).toHaveBeenCalledWith(
      { provider: "chroma", configId: "credential-1" },
      {
        name: "new-col",
        dimension: 1536,
        description: undefined,
        embedding_model: undefined,
        embedding_provider: undefined,
        metadata: { owner: "me" },
      }
    )

    mockVectorCloudInvoke.deleteCollection.mockResolvedValueOnce(undefined)
    await store.deleteCollection("old-col")
    expect(mockVectorCloudInvoke.deleteCollection).toHaveBeenCalledWith(
      { provider: "chroma", configId: "credential-1" },
      "old-col"
    )

    mockVectorCloudInvoke.listCollections.mockResolvedValueOnce([
      { name: "a", document_count: 1, dimension: 3, description: "A" },
      { name: "b", document_count: 0, dimension: 0 },
    ])
    await expect(store.listCollections()).resolves.toEqual([
      { name: "a", documentCount: 1, dimension: 3, description: "A" },
      { name: "b", documentCount: 0, dimension: undefined, description: undefined },
    ])

    mockVectorCloudInvoke.getCollection.mockResolvedValueOnce({
      name: "a",
      document_count: 1,
      dimension: 0,
      description: undefined,
    })
    await expect(store.getCollectionInfo("a")).resolves.toEqual({
      name: "a",
      documentCount: 1,
      dimension: undefined,
      description: undefined,
    })

    mockVectorCloudInvoke.count.mockResolvedValueOnce(9)
    await expect(store.countDocuments!("cloud-col")).resolves.toBe(9)
    expect(mockVectorCloudInvoke.count).toHaveBeenCalledWith(
      { provider: "chroma", configId: "credential-1" },
      "cloud-col",
      undefined
    )

    mockVectorCloudInvoke.query.mockResolvedValueOnce({
      results: [
        { id: "match", content: "match", payload: { status: "active" }, score: 0.7 },
        { id: "miss", content: "miss", payload: { status: "archived" }, score: 0.6 },
      ],
    })
    await expect(
      store.countDocuments!("cloud-col", {
        filters: [{ key: "status", value: "active", operation: "equals" }],
      })
    ).resolves.toBe(1)

    mockVectorCloudInvoke.query.mockResolvedValueOnce({
      results: [{ id: "native-filter", content: "match", payload: {}, score: 0.8 }],
    })
    await expect(
      store.countDocuments!("cloud-col", { filter: { status: "active" } })
    ).resolves.toBe(1)
  })
})

describe("NativeVectorStore", () => {
  let store: NativeVectorStore

  beforeEach(() => {
    store = new NativeVectorStore(mockConfig)
    mockInvoke.mockClear()
  })

  describe("createCollection", () => {
    it("creates collection with basic options", async () => {
      mockInvoke.mockResolvedValue(true)

      await store.createCollection("test-collection")

      expect(mockInvoke).toHaveBeenCalledWith("vector_create_collection", {
        name: "test-collection",
        dimension: 1536,
        metadata: undefined,
        description: undefined,
        embedding_model: "text-embedding-3-small",
        embedding_provider: "openai",
      })
    })

    it("creates collection with all options", async () => {
      mockInvoke.mockResolvedValue(true)

      await store.createCollection("test-collection", {
        dimension: 768,
        metadata: { type: "test" },
        description: "Test collection",
        embeddingModel: "custom-model",
        embeddingProvider: "custom-provider",
      })

      expect(mockInvoke).toHaveBeenCalledWith("vector_create_collection", {
        name: "test-collection",
        dimension: 768,
        metadata: { type: "test" },
        description: "Test collection",
        embedding_model: "custom-model",
        embedding_provider: "custom-provider",
      })
    })

    it("throws error when not in Tauri environment", async () => {
      const originalTauri = window.__TAURI_INTERNALS__

      // Completely remove __TAURI_INTERNALS__ property
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

      // Verify __TAURI_INTERNALS__ is actually removed
      expect("__TAURI_INTERNALS__" in window).toBe(false)

      const store = new NativeVectorStore(mockConfig)

      await expect(store.createCollection("test")).rejects.toThrow(
        "Native vector store is only available in Tauri environment"
      )

      // Restore for other tests
      if (originalTauri !== undefined) {
        window.__TAURI_INTERNALS__ = originalTauri
      } else {
        window.__TAURI_INTERNALS__ = {}
      }
    })
  })

  describe("deleteCollection", () => {
    it("deletes collection", async () => {
      mockInvoke.mockResolvedValue(true)

      await store.deleteCollection("test-collection")

      expect(mockInvoke).toHaveBeenCalledWith("vector_delete_collection", {
        name: "test-collection",
      })
    })
  })

  describe("truncateCollection", () => {
    it("truncates collection", async () => {
      mockInvoke.mockResolvedValue(true)

      await store.truncateCollection("test-collection")

      expect(mockInvoke).toHaveBeenCalledWith("vector_truncate_collection", {
        name: "test-collection",
      })
    })
  })

  describe("addDocuments", () => {
    it("adds documents with embeddings", async () => {
      const documents: VectorDocument[] = [
        {
          id: "doc1",
          content: "test content 1",
          metadata: { type: "test" },
          embedding: [0.1, 0.2, 0.3],
        },
        {
          id: "doc2",
          content: "test content 2",
          embedding: [0.4, 0.5, 0.6],
        },
      ]

      mockInvoke.mockResolvedValue(true)

      await store.addDocuments("test-collection", documents)

      expect(mockInvoke).toHaveBeenCalledWith("vector_upsert_points", {
        collection: "test-collection",
        points: [
          {
            id: "doc1",
            vector: [0.1, 0.2, 0.3],
            payload: { content: "test content 1", type: "test" },
          },
          {
            id: "doc2",
            vector: [0.4, 0.5, 0.6],
            payload: { content: "test content 2" },
          },
        ],
      })
    })

    it("generates embeddings for documents without them", async () => {
      const documents: VectorDocument[] = [
        {
          id: "doc1",
          content: "test content 1",
          // No embedding - should be generated
        },
        {
          id: "doc2",
          content: "test content 2",
          embedding: [0.4, 0.5, 0.6], // Has embedding
        },
      ]

      mockInvoke.mockResolvedValue(true)
      mockGenerateEmbeddings.mockResolvedValue({
        embeddings: [[0.7, 0.8, 0.9]], // Only one embedding for doc1
        model: "test-model",
        provider: "openai",
      })

      await store.addDocuments("test-collection", documents)

      expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
        ["test content 1"], // Only doc1's content
        mockEmbeddingConfig,
        "test-api-key"
      )

      expect(mockInvoke).toHaveBeenCalledWith("vector_upsert_points", {
        collection: "test-collection",
        points: [
          {
            id: "doc1",
            vector: [0.7, 0.8, 0.9], // Generated embedding
            payload: { content: "test content 1" },
          },
          {
            id: "doc2",
            vector: [0.4, 0.5, 0.6], // Original embedding
            payload: { content: "test content 2" },
          },
        ],
      })
    })
  })

  describe("deleteDocuments", () => {
    it("deletes documents", async () => {
      mockInvoke.mockResolvedValue(true)

      await store.deleteDocuments("test-collection", ["doc1", "doc2"])

      expect(mockInvoke).toHaveBeenCalledWith("vector_delete_points", {
        collection: "test-collection",
        ids: ["doc1", "doc2"],
      })
    })
  })

  describe("searchDocuments", () => {
    beforeEach(() => {
      mockGenerateEmbedding.mockResolvedValue({
        embedding: [0.1, 0.2, 0.3],
        model: "test-model",
        provider: "openai",
      })
    })

    it("searches with basic options", async () => {
      const mockResults = [
        {
          id: "doc1",
          score: 0.95,
          payload: { content: "test content 1", type: "test" },
        },
        {
          id: "doc2",
          score: 0.87,
          payload: { content: "test content 2" },
        },
      ]

      mockInvoke.mockResolvedValue(mockResults)

      const results = await store.searchDocuments("test-collection", "search query")

      expect(mockGenerateEmbedding).toHaveBeenCalledWith(
        "search query",
        mockEmbeddingConfig,
        "test-api-key"
      )

      expect(mockInvoke).toHaveBeenCalledWith("vector_search_points", {
        collection: "test-collection",
        vector: [0.1, 0.2, 0.3],
        top_k: 5,
        score_threshold: undefined,
        offset: undefined,
        limit: undefined,
        filters: undefined,
        filter_mode: undefined,
      })

      expect(results).toEqual([
        {
          id: "doc1",
          content: "test content 1",
          metadata: { content: "test content 1", type: "test" },
          score: 0.95,
        },
        {
          id: "doc2",
          content: "test content 2",
          metadata: { content: "test content 2" },
          score: 0.87,
        },
      ])
    })

    it("searches with advanced options", async () => {
      const filters: PayloadFilter[] = [
        {
          key: "type",
          value: "document",
          operation: "equals",
        },
        {
          key: "score",
          value: 90,
          operation: "greater_than",
        },
      ]

      mockInvoke.mockResolvedValue([])

      await store.searchDocuments("test-collection", "search query", {
        topK: 10,
        threshold: 0.8,
        offset: 5,
        limit: 3,
        filters,
      })

      expect(mockInvoke).toHaveBeenCalledWith("vector_search_points", {
        collection: "test-collection",
        vector: [0.1, 0.2, 0.3],
        top_k: 10,
        score_threshold: 0.8,
        offset: 5,
        limit: 3,
        filters: [
          {
            key: "type",
            value: "document",
            operation: "equals",
          },
          {
            key: "score",
            value: 90,
            operation: "greater_than",
          },
        ],
        filter_mode: undefined,
      })
    })

    it("handles empty results", async () => {
      mockInvoke.mockResolvedValue([])

      const results = await store.searchDocuments("test-collection", "no matches")

      expect(results).toEqual([])
    })

    it("handles null results", async () => {
      mockInvoke.mockResolvedValue(null)

      const results = await store.searchDocuments("test-collection", "null results")

      expect(results).toEqual([])
    })

    it("applies threshold and pagination to legacy array responses", async () => {
      mockInvoke.mockResolvedValue([
        { id: "high", score: 0.95, payload: { content: "high" } },
        { id: "mid", score: 0.75, payload: { content: "mid" } },
        { id: "low", score: 0.2, payload: { content: "low" } },
      ])

      const results = await store.searchByEmbedding!("test-collection", [0.1, 0.2, 0.3], {
        threshold: 0.5,
        offset: 1,
        limit: 1,
      })

      expect(results).toEqual([
        { id: "mid", content: "mid", metadata: { content: "mid" }, score: 0.75 },
      ])
    })
  })

  describe("getDocuments", () => {
    it("gets documents by IDs", async () => {
      const mockResults = [
        {
          id: "doc1",
          vector: [0.1, 0.2, 0.3],
          payload: { content: "test content 1", type: "test" },
        },
      ]

      mockInvoke.mockResolvedValue(mockResults)

      const results = await store.getDocuments("test-collection", ["doc1"])

      expect(mockInvoke).toHaveBeenCalledWith("vector_get_points", {
        collection: "test-collection",
        ids: ["doc1"],
      })

      expect(results).toEqual([
        {
          id: "doc1",
          content: "test content 1",
          metadata: { content: "test content 1", type: "test" },
          embedding: [0.1, 0.2, 0.3],
        },
      ])
    })
  })

  describe("listCollections", () => {
    it("lists all collections", async () => {
      const mockCollections = [
        {
          name: "collection1",
          dimension: 1536,
          metadata: { type: "test" },
          document_count: 5,
          created_at: "2022-01-01T00:00:00.000Z",
          updated_at: "2022-01-01T00:01:40.000Z",
          description: "Test collection 1",
          embedding_model: "model1",
          embedding_provider: "provider1",
        },
        {
          name: "collection2",
          dimension: 768,
          document_count: 3,
          created_at: "2022-01-01T00:03:20.000Z",
          updated_at: "2022-01-01T00:05:00.000Z",
        },
      ]

      mockInvoke.mockResolvedValue(mockCollections)

      const results = await store.listCollections()

      expect(mockInvoke).toHaveBeenCalledWith("vector_list_collections", undefined)

      expect(results).toEqual([
        {
          name: "collection1",
          documentCount: 5,
          dimension: 1536,
          metadata: { type: "test" },
          createdAt: 1640995200000,
          updatedAt: 1640995300000,
          description: "Test collection 1",
          embeddingModel: "model1",
          embeddingProvider: "provider1",
        },
        {
          name: "collection2",
          documentCount: 3,
          dimension: 768,
          metadata: undefined,
          createdAt: 1640995400000,
          updatedAt: 1640995500000,
          description: undefined,
          embeddingModel: undefined,
          embeddingProvider: undefined,
        },
      ])
    })

    it("handles empty collection list", async () => {
      mockInvoke.mockResolvedValue([])

      const results = await store.listCollections()

      expect(results).toEqual([])
    })
  })

  describe("getCollectionInfo", () => {
    it("gets collection info", async () => {
      const mockInfo = {
        name: "test-collection",
        dimension: 1536,
        metadata: { type: "test" },
        document_count: 10,
        created_at: "2022-01-01T00:00:00.000Z",
        updated_at: "2022-01-01T00:01:40.000Z",
        description: "Test collection",
        embedding_model: "test-model",
        embedding_provider: "test-provider",
      }

      mockInvoke.mockResolvedValue(mockInfo)

      const result = await store.getCollectionInfo("test-collection")

      expect(mockInvoke).toHaveBeenCalledWith("vector_get_collection", {
        name: "test-collection",
      })

      expect(result).toEqual({
        name: "test-collection",
        documentCount: 10,
        dimension: 1536,
        metadata: { type: "test" },
        createdAt: 1640995200000,
        updatedAt: 1640995300000,
        description: "Test collection",
        embeddingModel: "test-model",
        embeddingProvider: "test-provider",
      })
    })
  })

  describe("updateDocuments", () => {
    it("updates documents using upsert semantics", async () => {
      const documents: VectorDocument[] = [
        {
          id: "doc1",
          content: "updated content",
          embedding: [0.7, 0.8, 0.9],
        },
      ]

      mockInvoke.mockResolvedValue(true)

      await store.updateDocuments("test-collection", documents)

      // Should call the same method as addDocuments
      expect(mockInvoke).toHaveBeenCalledWith("vector_upsert_points", {
        collection: "test-collection",
        points: [
          {
            id: "doc1",
            vector: [0.7, 0.8, 0.9],
            payload: { content: "updated content" },
          },
        ],
      })
    })
  })

  describe("web-mode rejection", () => {
    let storeNoTauri: NativeVectorStore

    beforeEach(() => {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
      storeNoTauri = new NativeVectorStore(mockConfig)
    })

    afterEach(() => {
      window.__TAURI_INTERNALS__ = {}
    })

    const webModeError = "Native vector store is only available in Tauri environment"

    it("rejects addDocuments", async () => {
      await expect(
        storeNoTauri.addDocuments("col", [{ id: "1", content: "x", embedding: [0.1] }])
      ).rejects.toThrow(webModeError)
    })

    it("rejects updateDocuments", async () => {
      await expect(
        storeNoTauri.updateDocuments("col", [{ id: "1", content: "x", embedding: [0.1] }])
      ).rejects.toThrow(webModeError)
    })

    it("rejects deleteDocuments", async () => {
      await expect(storeNoTauri.deleteDocuments("col", ["1"])).rejects.toThrow(webModeError)
    })

    it("rejects deleteAllDocuments", async () => {
      await expect(storeNoTauri.deleteAllDocuments("col")).rejects.toThrow(webModeError)
    })

    it("rejects searchDocuments", async () => {
      await expect(storeNoTauri.searchDocuments("col", "query")).rejects.toThrow(webModeError)
    })

    it("rejects searchByEmbedding", async () => {
      await expect(storeNoTauri.searchByEmbedding!("col", [0.1, 0.2])).rejects.toThrow(webModeError)
    })

    it("rejects searchDocumentsWithTotal", async () => {
      await expect(storeNoTauri.searchDocumentsWithTotal!("col", "query")).rejects.toThrow(
        webModeError
      )
    })

    it("rejects getDocuments", async () => {
      await expect(storeNoTauri.getDocuments("col", ["1"])).rejects.toThrow(webModeError)
    })

    it("rejects createCollection", async () => {
      await expect(storeNoTauri.createCollection("col")).rejects.toThrow(webModeError)
    })

    it("rejects deleteCollection", async () => {
      await expect(storeNoTauri.deleteCollection("col")).rejects.toThrow(webModeError)
    })

    it("rejects truncateCollection", async () => {
      await expect(storeNoTauri.truncateCollection!("col")).rejects.toThrow(webModeError)
    })

    it("rejects listCollections", async () => {
      await expect(storeNoTauri.listCollections()).rejects.toThrow(webModeError)
    })

    it("rejects getCollectionInfo", async () => {
      await expect(storeNoTauri.getCollectionInfo("col")).rejects.toThrow(webModeError)
    })
  })

  describe("addDocuments payload shape", () => {
    it("sends flat collection+points payload with content in payload field", async () => {
      mockInvoke.mockResolvedValue(undefined)

      const docs: VectorDocument[] = [
        { id: "p1", content: "hello world", metadata: { tag: "a" }, embedding: [0.1, 0.2, 0.3] },
      ]

      await store.addDocuments("my-col", docs)

      expect(mockInvoke).toHaveBeenCalledWith("vector_upsert_points", {
        collection: "my-col",
        points: [
          {
            id: "p1",
            vector: [0.1, 0.2, 0.3],
            payload: { content: "hello world", tag: "a" },
          },
        ],
      })
    })
  })

  describe("score pass-through (Rust returns final score)", () => {
    it("does not re-convert score — passes through directly", async () => {
      mockGenerateEmbedding.mockResolvedValue({
        embedding: [0.1, 0.2, 0.3],
        model: "test-model",
        provider: "openai",
      })

      mockInvoke.mockResolvedValue({
        results: [{ id: "p1", score: 0.85, content: "some text", payload: { x: 1 } }],
        total: 1,
        offset: 0,
        limit: 10,
      })

      const results = await store.searchDocuments("col", "query", { topK: 10 })

      expect(results).toHaveLength(1)
      expect(results[0].score).toBe(0.85)
      expect(results[0].id).toBe("p1")
      expect(results[0].content).toBe("some text")
    })
  })

  describe("searchByEmbeddingWithTotal back-compat branches", () => {
    it("legacy array response: back-compat branch reconstructs SearchResponse", async () => {
      mockInvoke.mockResolvedValue([
        { id: "r1", score: 0.9, payload: { content: "legacy content", meta: "v" } },
        { id: "r2", score: 0.7, payload: { content: "legacy 2" } },
      ])

      const result = await store.searchDocumentsWithTotal!("col", "q")

      expect(result.results).toHaveLength(2)
      expect(result.results[0]).toMatchObject({ id: "r1", score: 0.9, content: "legacy content" })
      expect(result.results[1]).toMatchObject({ id: "r2", score: 0.7, content: "legacy 2" })
      // total/offset/limit populated by applyThresholdAndPagination helper
      expect(typeof result.total).toBe("number")
    })

    it("tagged response: passes through results, total, offset, limit", async () => {
      mockInvoke.mockResolvedValue({
        results: [{ id: "t1", score: 0.75, content: "tagged", payload: { k: "v" } }],
        total: 42,
        offset: 10,
        limit: 5,
      })

      const result = await store.searchDocumentsWithTotal!("col", "q")

      expect(result.results[0]).toMatchObject({ id: "t1", score: 0.75, content: "tagged" })
      expect(result.total).toBe(42)
      expect(result.offset).toBe(10)
      expect(result.limit).toBe(5)
    })

    it("tagged response defaults missing result and paging fields", async () => {
      mockInvoke.mockResolvedValue({})

      await expect(store.searchDocumentsWithTotal!("col", "q")).resolves.toEqual({
        results: [],
        total: 0,
        offset: 0,
        limit: 0,
      })
    })
  })

  describe("filter pass-through", () => {
    it("passes filter array unmodified in flat search payload", async () => {
      mockGenerateEmbedding.mockResolvedValue({
        embedding: [0.1, 0.2, 0.3],
        model: "test-model",
        provider: "openai",
      })
      mockInvoke.mockResolvedValue({ results: [], total: 0, offset: 0, limit: 5 })

      const filters: PayloadFilter[] = [{ key: "category", value: "x", operation: "equals" }]
      await store.searchDocuments("col", "q", { filters, filterMode: "and" })

      expect(mockInvoke).toHaveBeenCalledWith(
        "vector_search_points",
        expect.objectContaining({
          filters: [{ key: "category", value: "x", operation: "equals" }],
          filter_mode: "and",
        })
      )
    })
  })

  describe("native-backed operations route through the Tauri command surface", () => {
    // Earlier revisions of the native backend stubbed these methods to throw
    // "not yet supported". They were since implemented (see store.ts:
    // scrollDocuments→vector_scroll_points, renameCollection→
    // vector_rename_collection, exportCollection/importCollection→
    // vector_export_collection/vector_import_collection, getStats→
    // vector_list_collections + vector_get_stats + vector_get_store_size,
    // countDocuments→vector_count_points). These assertions lock the
    // observable Tauri-command surface for each method so future refactors
    // keep the contract intact.
    it("scrollDocuments invokes vector_scroll_points + vector_count_points", async () => {
      mockInvoke.mockResolvedValueOnce({ points: [], next_cursor: undefined, has_more: false })
      mockInvoke.mockResolvedValueOnce(0)
      const result = await store.scrollDocuments!("col")
      expect(mockInvoke).toHaveBeenCalledWith(
        "vector_scroll_points",
        expect.objectContaining({ collection: "col", limit: 100 })
      )
      expect(mockInvoke).toHaveBeenCalledWith("vector_count_points", { collection: "col" })
      expect(result).toEqual({
        documents: [],
        total: 0,
        offset: 0,
        limit: 100,
        hasMore: false,
      })
    })

    it("scrollDocuments maps returned points into documents", async () => {
      mockInvoke.mockResolvedValueOnce({
        points: [{ id: "p1", vector: [0.1], payload: { content: "point content", tag: "a" } }],
        next_cursor: "p1",
        has_more: true,
      })
      mockInvoke.mockResolvedValueOnce(2)

      await expect(store.scrollDocuments!("col", { limit: 1 })).resolves.toEqual({
        documents: [
          {
            id: "p1",
            content: "point content",
            metadata: { content: "point content", tag: "a" },
            embedding: [0.1],
          },
        ],
        total: 2,
        offset: 0,
        limit: 1,
        hasMore: true,
      })
    })

    it("scrollDocuments rejects non-zero offsets so callers go through cursor paging", async () => {
      await expect(store.scrollDocuments!("col", { offset: 50 })).rejects.toThrow(/offset=0/)
    })

    it("renameCollection invokes vector_rename_collection with from/to", async () => {
      mockInvoke.mockResolvedValueOnce(undefined)
      await store.renameCollection!("a", "b")
      expect(mockInvoke).toHaveBeenCalledWith("vector_rename_collection", { from: "a", to: "b" })
    })

    it("exportCollection parses the JSONL header + points payload", async () => {
      const jsonl = [
        JSON.stringify({
          kind: "collection",
          name: "col",
          dim: 3,
          point_count: 1,
        }),
        JSON.stringify({ kind: "point", id: "p1", vector: [0.1, 0.2, 0.3], payload: { x: 1 } }),
      ].join("\n")
      mockInvoke.mockResolvedValueOnce(jsonl)
      const result = await store.exportCollection!("col")
      expect(mockInvoke).toHaveBeenCalledWith("vector_export_collection", { collection: "col" })
      expect(result.meta.name).toBe("col")
      expect(result.points).toHaveLength(1)
      expect(result.points[0]?.id).toBe("p1")
    })

    it("exportCollection defaults optional header and point fields", async () => {
      const jsonl = [
        JSON.stringify({
          kind: "collection",
          name: "col",
          dim: 3,
          created_at: "not-a-date",
          updated_at: undefined,
        }),
        JSON.stringify({ kind: "point" }),
      ].join("\n")
      mockInvoke.mockResolvedValueOnce(jsonl)

      const result = await store.exportCollection!("col")

      expect(result.meta).toMatchObject({
        name: "col",
        dimension: 3,
        documentCount: 0,
        createdAt: undefined,
        updatedAt: undefined,
      })
      expect(result.points).toEqual([{ id: "", vector: [], payload: undefined }])
    })

    it("exportCollection rejects empty exports and wrong JSONL header kinds", async () => {
      mockInvoke.mockResolvedValueOnce("")
      await expect(store.exportCollection!("empty")).rejects.toThrow("empty export")

      mockInvoke.mockResolvedValueOnce(JSON.stringify({ kind: "point", name: "bad", dim: 3 }))
      await expect(store.exportCollection!("bad")).rejects.toThrow(
        'expected header kind="collection"'
      )
    })

    it("importCollection re-packs the structured payload into JSONL", async () => {
      mockInvoke.mockResolvedValueOnce(undefined)
      const data: CollectionImport = {
        meta: { name: "x", documentCount: 1, dimension: 3 },
        points: [{ id: "p1", vector: [0.1, 0.2, 0.3], payload: { content: "hi" } }],
      }
      await store.importCollection!(data, true)
      expect(mockInvoke).toHaveBeenCalledWith(
        "vector_import_collection",
        expect.objectContaining({ collection: "x", overwrite: true })
      )
      const callArgs = mockInvoke.mock.calls.at(-1)?.[1] as { jsonl: string } | undefined
      expect(callArgs?.jsonl.split("\n")).toHaveLength(2)
    })

    it("importCollection includes timestamps and defaults overwrite to false", async () => {
      mockInvoke.mockResolvedValueOnce(undefined)
      const data: CollectionImport = {
        meta: {
          name: "dated",
          documentCount: 0,
          dimension: 3,
          createdAt: 1640995200000,
          updatedAt: 1640995300000,
        },
        points: [],
      }

      await store.importCollection!(data)

      const callArgs = mockInvoke.mock.calls.at(-1)?.[1] as
        | { jsonl: string; overwrite: boolean }
        | undefined
      expect(callArgs?.overwrite).toBe(false)
      expect(callArgs?.jsonl).toContain("2022-01-01T00:00:00.000Z")
      expect(callArgs?.jsonl).toContain("2022-01-01T00:01:40.000Z")
    })

    it("getStats aggregates listCollections + per-collection counts + store size", async () => {
      mockInvoke.mockResolvedValueOnce([{ name: "a", dimension: 3 }])
      mockInvoke.mockResolvedValueOnce({ count: 7 })
      mockInvoke.mockResolvedValueOnce(1024)
      const stats = await store.getStats!()
      expect(stats.collectionCount).toBe(1)
      expect(stats.totalPoints).toBe(7)
      expect(stats.storageSizeBytes).toBe(1024)
    })

    it("getStats ignores collections that vanish while stats are being collected", async () => {
      mockInvoke.mockResolvedValueOnce([{ name: "gone", dimension: 3 }])
      mockInvoke.mockRejectedValueOnce(new Error("gone"))
      mockInvoke.mockResolvedValueOnce(0)

      const stats = await store.getStats!()

      expect(stats.totalPoints).toBe(0)
      expect(stats.collectionCount).toBe(1)
    })

    it("getStats treats missing per-collection counts as zero", async () => {
      mockInvoke.mockResolvedValueOnce([{ name: "a", dimension: 3 }])
      mockInvoke.mockResolvedValueOnce({})
      mockInvoke.mockResolvedValueOnce(0)

      const stats = await store.getStats!()

      expect(stats.totalPoints).toBe(0)
      expect(stats.collectionCount).toBe(1)
    })

    it("getStoreSize returns 0 outside Tauri", async () => {
      const originalTauri = window.__TAURI_INTERNALS__
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

      await expect(store.getStoreSize()).resolves.toBe(0)

      window.__TAURI_INTERNALS__ = originalTauri ?? {}
    })

    it("countDocuments invokes vector_count_points when no filters are supplied", async () => {
      mockInvoke.mockResolvedValueOnce(42)
      const count = await store.countDocuments!("col")
      expect(mockInvoke).toHaveBeenCalledWith("vector_count_points", { collection: "col" })
      expect(count).toBe(42)
    })

    it("countDocuments routes through vector_search_points when payload filters are supplied", async () => {
      mockInvoke.mockResolvedValueOnce({ total: 5 })
      const count = await store.countDocuments!("col", {
        filters: [{ key: "category", value: "x", operation: "equals" }],
      })
      expect(mockInvoke).toHaveBeenCalledWith(
        "vector_search_points",
        expect.objectContaining({ collection: "col", top_k: 1 })
      )
      expect(count).toBe(5)
    })

    it("countDocuments routes through vector_search_points when native filter object is supplied", async () => {
      mockInvoke.mockResolvedValueOnce({ total: 6 })

      await expect(store.countDocuments!("col", { filter: { source: "manual" } })).resolves.toBe(6)

      expect(mockInvoke).toHaveBeenCalledWith(
        "vector_search_points",
        expect.objectContaining({ collection: "col", top_k: 1 })
      )
    })

    it("countDocuments defaults missing search totals to zero", async () => {
      mockInvoke.mockResolvedValueOnce({})

      await expect(
        store.countDocuments!("col", {
          filters: [{ key: "category", value: "x", operation: "equals" }],
          filterMode: "or",
        })
      ).resolves.toBe(0)

      expect(mockInvoke).toHaveBeenCalledWith(
        "vector_search_points",
        expect.objectContaining({ filter_mode: "or" })
      )
    })
  })
})
