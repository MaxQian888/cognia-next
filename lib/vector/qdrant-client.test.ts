/**
 * Tests for Qdrant Vector Database Client
 */

import { QdrantClient } from "@qdrant/js-client-rest"
import {
  getQdrantClient,
  resetQdrantClient,
  createQdrantCollection,
  deleteQdrantCollection,
  listQdrantCollections,
  collectionExists,
  upsertQdrantDocuments,
  queryQdrant,
  deleteQdrantDocuments,
  deleteQdrantByFilter,
  getQdrantDocuments,
  getQdrantCollectionInfo,
  scrollQdrantCollection,
  type QdrantConfig,
  type QdrantDocument,
} from "./qdrant-client"

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

import * as embeddingModule from "./embedding"
const mockGenerateEmbedding = jest.mocked(embeddingModule.generateEmbedding)
const mockGenerateEmbeddings = jest.mocked(embeddingModule.generateEmbeddings)

const mockConfig: QdrantConfig = {
  url: "http://localhost:6333",
  apiKey: "test-api-key",
  collectionName: "test-collection",
  embeddingConfig: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  embeddingApiKey: "test-embedding-key",
}

describe("getQdrantClient", () => {
  beforeEach(() => {
    resetQdrantClient()
    jest.clearAllMocks()
  })

  it("creates client with URL", () => {
    const client = getQdrantClient("http://localhost:6333")
    expect(client).toBeDefined()
    expect(QdrantClient).toHaveBeenCalledWith({
      url: "http://localhost:6333",
      apiKey: undefined,
    })
  })

  it("creates client with API key", () => {
    const client = getQdrantClient("http://localhost:6333", "api-key")
    expect(client).toBeDefined()
    expect(QdrantClient).toHaveBeenCalledWith({
      url: "http://localhost:6333",
      apiKey: "api-key",
    })
  })

  it("reuses existing client instance", () => {
    resetQdrantClient()
    getQdrantClient("http://localhost:6333")
    getQdrantClient("http://localhost:6333")
    // Should reuse existing instance
    expect(QdrantClient).toHaveBeenCalled()
  })
})

describe("resetQdrantClient", () => {
  it("resets the client instance", () => {
    resetQdrantClient()
    getQdrantClient("http://localhost:6333")
    resetQdrantClient()
    getQdrantClient("http://localhost:6333")
    // After reset, new instance should be created
    expect(QdrantClient).toHaveBeenCalled()
  })
})

describe("createQdrantCollection", () => {
  let client: QdrantClient

  beforeEach(() => {
    resetQdrantClient()
    client = getQdrantClient(mockConfig.url, mockConfig.apiKey)
    jest.clearAllMocks()
  })

  it("creates collection with vector size", async () => {
    await createQdrantCollection(client, "new-collection", 1536)

    expect(client.createCollection).toHaveBeenCalledWith("new-collection", {
      vectors: {
        size: 1536,
        distance: "Cosine",
      },
      on_disk_payload: false,
    })
  })

  it("creates collection with custom distance", async () => {
    await createQdrantCollection(client, "new-collection", 1536, {
      distance: "Euclid",
    })

    expect(client.createCollection).toHaveBeenCalledWith("new-collection", {
      vectors: {
        size: 1536,
        distance: "Euclid",
      },
      on_disk_payload: false,
    })
  })

  it("creates collection with on-disk payload", async () => {
    await createQdrantCollection(client, "new-collection", 1536, {
      onDiskPayload: true,
    })

    expect(client.createCollection).toHaveBeenCalledWith("new-collection", {
      vectors: {
        size: 1536,
        distance: "Cosine",
      },
      on_disk_payload: true,
    })
  })
})

describe("deleteQdrantCollection", () => {
  let client: QdrantClient

  beforeEach(() => {
    resetQdrantClient()
    client = getQdrantClient(mockConfig.url)
    jest.clearAllMocks()
  })

  it("deletes collection by name", async () => {
    await deleteQdrantCollection(client, "test-collection")

    expect(client.deleteCollection).toHaveBeenCalledWith("test-collection")
  })
})

describe("listQdrantCollections", () => {
  let client: QdrantClient

  beforeEach(() => {
    resetQdrantClient()
    client = getQdrantClient(mockConfig.url)
    jest.clearAllMocks()
    ;(client.getCollections as jest.Mock).mockResolvedValue({
      collections: [{ name: "collection1" }, { name: "collection2" }],
    })
    ;(client.getCollection as jest.Mock).mockResolvedValue({
      indexed_vectors_count: 100,
      points_count: 100,
      status: "green",
      config: {
        params: {
          vectors: {
            size: 1536,
            distance: "Cosine",
          },
        },
      },
    })
  })

  it("lists all collections with info", async () => {
    const collections = await listQdrantCollections(client)

    expect(collections).toHaveLength(2)
    expect(collections[0].name).toBe("collection1")
    expect(collections[1].name).toBe("collection2")
  })

  it("includes vector count and size", async () => {
    const collections = await listQdrantCollections(client)

    expect(collections[0].vectorsCount).toBe(100)
    expect(collections[0].vectorSize).toBe(1536)
    expect(collections[0].distance).toBe("Cosine")
  })

  it("handles collection errors gracefully", async () => {
    ;(client.getCollection as jest.Mock).mockRejectedValueOnce(new Error("Not found"))

    const collections = await listQdrantCollections(client)

    expect(collections[0].vectorsCount).toBe(0)
    expect(collections[0].status).toBe("unknown")
  })
})

describe("collectionExists", () => {
  let client: QdrantClient

  beforeEach(() => {
    resetQdrantClient()
    client = getQdrantClient(mockConfig.url)
    jest.clearAllMocks()
  })

  it("returns true when collection exists", async () => {
    ;(client.getCollection as jest.Mock).mockResolvedValue({})

    const exists = await collectionExists(client, "existing")
    expect(exists).toBe(true)
  })

  it("returns false when collection does not exist", async () => {
    ;(client.getCollection as jest.Mock).mockRejectedValue(new Error("Not found"))

    const exists = await collectionExists(client, "nonexistent")
    expect(exists).toBe(false)
  })
})

describe("upsertQdrantDocuments", () => {
  let client: QdrantClient

  beforeEach(() => {
    resetQdrantClient()
    client = getQdrantClient(mockConfig.url)
    jest.clearAllMocks()
  })

  it("upserts documents with provided embeddings", async () => {
    const documents: QdrantDocument[] = [
      { id: "doc1", content: "content 1", embedding: [0.1, 0.2, 0.3] },
      { id: "doc2", content: "content 2", embedding: [0.4, 0.5, 0.6] },
    ]

    await upsertQdrantDocuments(client, "test-collection", documents, mockConfig)

    expect(client.upsert).toHaveBeenCalledWith("test-collection", {
      wait: true,
      points: [
        {
          id: "doc1",
          vector: [0.1, 0.2, 0.3],
          payload: { content: "content 1" },
        },
        {
          id: "doc2",
          vector: [0.4, 0.5, 0.6],
          payload: { content: "content 2" },
        },
      ],
    })
  })

  it("generates embeddings for documents without them", async () => {
    const documents: QdrantDocument[] = [
      { id: "doc1", content: "content 1" },
      { id: "doc2", content: "content 2" },
    ]

    await upsertQdrantDocuments(client, "test-collection", documents, mockConfig)

    expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
      ["content 1", "content 2"],
      mockConfig.embeddingConfig,
      mockConfig.embeddingApiKey
    )
  })

  it("includes metadata in payload", async () => {
    const documents: QdrantDocument[] = [
      {
        id: "doc1",
        content: "content",
        metadata: { type: "test", score: 0.9 },
        embedding: [0.1, 0.2, 0.3],
      },
    ]

    await upsertQdrantDocuments(client, "test-collection", documents, mockConfig)

    expect(client.upsert).toHaveBeenCalledWith("test-collection", {
      wait: true,
      points: [
        {
          id: "doc1",
          vector: [0.1, 0.2, 0.3],
          payload: { content: "content", type: "test", score: 0.9 },
        },
      ],
    })
  })

  it("batches large document sets", async () => {
    const documents: QdrantDocument[] = Array.from({ length: 150 }, (_, i) => ({
      id: `doc${i}`,
      content: `content ${i}`,
      embedding: [0.1, 0.2, 0.3],
    }))

    await upsertQdrantDocuments(client, "test-collection", documents, mockConfig)

    expect(client.upsert).toHaveBeenCalledTimes(2)
  })
})

describe("queryQdrant", () => {
  let client: QdrantClient

  beforeEach(() => {
    resetQdrantClient()
    client = getQdrantClient(mockConfig.url)
    jest.clearAllMocks()
    ;(client.query as jest.Mock).mockResolvedValue({
      points: [
        { id: "doc1", score: 0.95, payload: { content: "result 1" } },
        { id: "doc2", score: 0.85, payload: { content: "result 2" } },
      ],
    })
  })

  it("queries with generated embedding", async () => {
    const results = await queryQdrant(client, "test-collection", "search query", mockConfig)

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      "search query",
      mockConfig.embeddingConfig,
      mockConfig.embeddingApiKey
    )

    expect(results).toHaveLength(2)
  })

  it("returns results with scores", async () => {
    const results = await queryQdrant(client, "test-collection", "query", mockConfig)

    expect(results[0].id).toBe("doc1")
    expect(results[0].score).toBe(0.95)
    expect(results[0].content).toBe("result 1")
  })

  it("respects topK option", async () => {
    await queryQdrant(client, "test-collection", "query", mockConfig, { topK: 10 })

    expect(client.query).toHaveBeenCalledWith(
      "test-collection",
      expect.objectContaining({
        limit: 10,
      })
    )
  })

  it("passes filter option", async () => {
    const filter = { must: [{ key: "type", match: { value: "test" } }] }

    await queryQdrant(client, "test-collection", "query", mockConfig, { filter })

    expect(client.query).toHaveBeenCalledWith(
      "test-collection",
      expect.objectContaining({
        filter,
      })
    )
  })

  it("passes score threshold", async () => {
    await queryQdrant(client, "test-collection", "query", mockConfig, { scoreThreshold: 0.8 })

    expect(client.query).toHaveBeenCalledWith(
      "test-collection",
      expect.objectContaining({
        score_threshold: 0.8,
      })
    )
  })

  it("falls back to search when query endpoint fails", async () => {
    ;(client.query as jest.Mock).mockRejectedValueOnce(new Error("query unavailable"))
    ;(client.search as jest.Mock).mockResolvedValueOnce([
      { id: "doc1", score: 0.95, payload: { content: "result 1" } },
    ])

    const results = await queryQdrant(client, "test-collection", "query", mockConfig)

    expect(client.search).toHaveBeenCalled()
    expect(results).toHaveLength(1)
  })
})

describe("deleteQdrantDocuments", () => {
  let client: QdrantClient

  beforeEach(() => {
    resetQdrantClient()
    client = getQdrantClient(mockConfig.url)
    jest.clearAllMocks()
  })

  it("deletes documents by IDs", async () => {
    await deleteQdrantDocuments(client, "test-collection", ["doc1", "doc2"])

    expect(client.delete).toHaveBeenCalledWith("test-collection", {
      wait: true,
      points: ["doc1", "doc2"],
    })
  })

  it("handles numeric IDs", async () => {
    await deleteQdrantDocuments(client, "test-collection", [1, 2, 3])

    expect(client.delete).toHaveBeenCalledWith("test-collection", {
      wait: true,
      points: [1, 2, 3],
    })
  })
})

describe("deleteQdrantByFilter", () => {
  let client: QdrantClient

  beforeEach(() => {
    resetQdrantClient()
    client = getQdrantClient(mockConfig.url)
    jest.clearAllMocks()
  })

  it("deletes documents by filter", async () => {
    const filter = { must: [{ key: "type", match: { value: "obsolete" } }] }

    await deleteQdrantByFilter(client, "test-collection", filter)

    expect(client.delete).toHaveBeenCalledWith("test-collection", {
      wait: true,
      filter,
    })
  })
})

describe("getQdrantDocuments", () => {
  let client: QdrantClient

  beforeEach(() => {
    resetQdrantClient()
    client = getQdrantClient(mockConfig.url)
    jest.clearAllMocks()
    ;(client.retrieve as jest.Mock).mockResolvedValue([
      {
        id: "doc1",
        payload: { content: "content 1", type: "test" },
        vector: [0.1, 0.2, 0.3],
      },
    ])
  })

  it("retrieves documents by IDs", async () => {
    const documents = await getQdrantDocuments(client, "test-collection", ["doc1"])

    expect(client.retrieve).toHaveBeenCalledWith("test-collection", {
      ids: ["doc1"],
      with_payload: true,
      with_vector: true,
    })

    expect(documents).toHaveLength(1)
    expect(documents[0].id).toBe("doc1")
    expect(documents[0].content).toBe("content 1")
  })
})

describe("getQdrantCollectionInfo", () => {
  let client: QdrantClient

  beforeEach(() => {
    resetQdrantClient()
    client = getQdrantClient(mockConfig.url)
    jest.clearAllMocks()
    ;(client.getCollection as jest.Mock).mockResolvedValue({
      indexed_vectors_count: 100,
      points_count: 100,
      status: "green",
      config: {
        params: {
          vectors: {
            size: 1536,
            distance: "Cosine",
          },
        },
      },
    })
  })

  it("returns collection info", async () => {
    const info = await getQdrantCollectionInfo(client, "test-collection")

    expect(info.name).toBe("test-collection")
    expect(info.vectorsCount).toBe(100)
    expect(info.pointsCount).toBe(100)
    expect(info.status).toBe("green")
    expect(info.vectorSize).toBe(1536)
    expect(info.distance).toBe("Cosine")
  })
})

describe("scrollQdrantCollection", () => {
  let client: QdrantClient

  beforeEach(() => {
    resetQdrantClient()
    client = getQdrantClient(mockConfig.url)
    jest.clearAllMocks()
    ;(client.scroll as jest.Mock).mockResolvedValue({
      points: [
        { id: "doc1", payload: { content: "content 1" } },
        { id: "doc2", payload: { content: "content 2" } },
      ],
      next_page_offset: "offset123",
    })
  })

  it("scrolls through collection", async () => {
    const result = await scrollQdrantCollection(client, "test-collection")

    expect(client.scroll).toHaveBeenCalledWith("test-collection", {
      limit: 100,
      offset: undefined,
      filter: undefined,
      with_payload: true,
      with_vector: false,
    })

    expect(result.documents).toHaveLength(2)
    expect(result.nextOffset).toBe("offset123")
  })

  it("respects custom options", async () => {
    await scrollQdrantCollection(client, "test-collection", {
      limit: 50,
      offset: "previous-offset",
      withVector: true,
    })

    expect(client.scroll).toHaveBeenCalledWith("test-collection", {
      limit: 50,
      offset: "previous-offset",
      filter: undefined,
      with_payload: true,
      with_vector: true,
    })
  })

  it("passes filter option", async () => {
    const filter = { must: [{ key: "type", match: { value: "test" } }] }

    await scrollQdrantCollection(client, "test-collection", { filter })

    expect(client.scroll).toHaveBeenCalledWith(
      "test-collection",
      expect.objectContaining({
        filter,
      })
    )
  })
})
