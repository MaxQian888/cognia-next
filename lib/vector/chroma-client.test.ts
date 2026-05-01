/**
 * Tests for ChromaDB Client
 */

import { ChromaClient, Collection } from "chromadb"
import {
  getChromaClient,
  resetChromaClient,
  getOrCreateCollection,
  deleteCollection,
  listCollections,
  addDocuments,
  updateDocuments,
  deleteDocuments,
  queryCollection,
  getDocuments,
  upsertDocuments,
  getCollectionCount,
  peekCollection,
  type ChromaConfig,
  type DocumentChunk,
} from "./chroma-client"

// Mock ChromaDB
jest.mock("chromadb", () => {
  const mockCollection = {
    add: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({
      ids: [["id1", "id2"]],
      documents: [["content1", "content2"]],
      metadatas: [[{ key: "value1" }, { key: "value2" }]],
      distances: [[0.1, 0.2]],
    }),
    get: jest.fn().mockResolvedValue({
      ids: ["id1"],
      documents: ["content1"],
      metadatas: [{ key: "value1" }],
      embeddings: [[0.1, 0.2, 0.3]],
    }),
    count: jest.fn().mockResolvedValue(10),
    peek: jest.fn().mockResolvedValue({
      ids: ["id1", "id2"],
      documents: ["content1", "content2"],
      metadatas: [{ key: "value1" }, { key: "value2" }],
    }),
  }

  const MockChromaClient = jest.fn().mockImplementation(() => ({
    getOrCreateCollection: jest.fn().mockResolvedValue(mockCollection),
    deleteCollection: jest.fn().mockResolvedValue(undefined),
    listCollections: jest
      .fn()
      .mockResolvedValue([{ name: "collection1" }, { name: "collection2" }]),
    getCollection: jest.fn().mockResolvedValue(mockCollection),
  }))

  return {
    ChromaClient: MockChromaClient,
    Collection: jest.fn(),
  }
})

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

const mockConfig: ChromaConfig = {
  mode: "embedded",
  embeddingConfig: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  apiKey: "test-api-key",
}

describe("getChromaClient", () => {
  beforeEach(() => {
    resetChromaClient()
    jest.clearAllMocks()
  })

  it("creates embedded client by default", () => {
    const client = getChromaClient(mockConfig)
    expect(client).toBeDefined()
    expect(ChromaClient).toHaveBeenCalled()
  })

  it("creates server client when mode is server", () => {
    const serverConfig: ChromaConfig = {
      ...mockConfig,
      mode: "server",
      serverUrl: "http://localhost:8000",
    }

    const client = getChromaClient(serverConfig)
    expect(client).toBeDefined()
    expect(ChromaClient).toHaveBeenCalledWith({
      path: "http://localhost:8000",
    })
  })

  it("reuses existing client instance", () => {
    resetChromaClient()
    const client1 = getChromaClient(mockConfig)
    const client2 = getChromaClient(mockConfig)
    expect(client1).toBe(client2)
  })
})

describe("resetChromaClient", () => {
  it("resets the client instance", () => {
    resetChromaClient()
    getChromaClient(mockConfig)
    resetChromaClient()
    getChromaClient(mockConfig)

    // New instance should be created after reset
    expect(ChromaClient).toHaveBeenCalled()
  })
})

describe("getOrCreateCollection", () => {
  let client: ChromaClient

  beforeEach(() => {
    resetChromaClient()
    client = getChromaClient(mockConfig)
    jest.clearAllMocks()
  })

  it("creates or gets collection with name", async () => {
    const collection = await getOrCreateCollection(client, "test-collection")

    expect(client.getOrCreateCollection).toHaveBeenCalledWith({
      name: "test-collection",
      metadata: undefined,
    })
    expect(collection).toBeDefined()
  })

  it("passes metadata when provided", async () => {
    const metadata = { description: "Test collection" }
    await getOrCreateCollection(client, "test-collection", metadata)

    expect(client.getOrCreateCollection).toHaveBeenCalledWith({
      name: "test-collection",
      metadata,
    })
  })
})

describe("deleteCollection", () => {
  let client: ChromaClient

  beforeEach(() => {
    resetChromaClient()
    client = getChromaClient(mockConfig)
    jest.clearAllMocks()
  })

  it("deletes collection by name", async () => {
    await deleteCollection(client, "test-collection")

    expect(client.deleteCollection).toHaveBeenCalledWith({
      name: "test-collection",
    })
  })
})

describe("listCollections", () => {
  let client: ChromaClient

  beforeEach(() => {
    resetChromaClient()
    client = getChromaClient(mockConfig)
    jest.clearAllMocks()
  })

  it("lists all collections with info", async () => {
    const collections = await listCollections(client)

    expect(collections).toHaveLength(2)
    expect(collections[0].name).toBe("collection1")
    expect(collections[1].name).toBe("collection2")
  })

  it("includes count for each collection", async () => {
    const collections = await listCollections(client)

    expect(collections[0].count).toBe(10)
  })

  it("handles collection errors gracefully", async () => {
    ;(client.getCollection as jest.Mock).mockRejectedValueOnce(new Error("Not found"))

    const collections = await listCollections(client)

    expect(collections[0].count).toBe(0)
  })
})

describe("addDocuments", () => {
  let collection: Collection

  beforeEach(async () => {
    resetChromaClient()
    const client = getChromaClient(mockConfig)
    collection = await getOrCreateCollection(client, "test")
    jest.clearAllMocks()
  })

  it("adds documents with provided embeddings", async () => {
    const documents: DocumentChunk[] = [
      { id: "doc1", content: "content 1", embedding: [0.1, 0.2, 0.3] },
      { id: "doc2", content: "content 2", embedding: [0.4, 0.5, 0.6] },
    ]

    await addDocuments(collection, documents, mockConfig)

    expect(collection.add).toHaveBeenCalledWith({
      ids: ["doc1", "doc2"],
      documents: ["content 1", "content 2"],
      metadatas: [{}, {}],
      embeddings: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
    })
  })

  it("generates embeddings for documents without them", async () => {
    const documents: DocumentChunk[] = [
      { id: "doc1", content: "content 1" },
      { id: "doc2", content: "content 2" },
    ]

    await addDocuments(collection, documents, mockConfig)

    expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
      ["content 1", "content 2"],
      mockConfig.embeddingConfig,
      mockConfig.apiKey
    )
  })

  it("merges provided and generated embeddings", async () => {
    mockGenerateEmbeddings.mockResolvedValueOnce({
      embeddings: [[0.7, 0.8, 0.9]],
      model: "test",
      provider: "openai",
    })

    const documents: DocumentChunk[] = [
      { id: "doc1", content: "content 1" },
      { id: "doc2", content: "content 2", embedding: [0.4, 0.5, 0.6] },
    ]

    await addDocuments(collection, documents, mockConfig)

    expect(collection.add).toHaveBeenCalledWith({
      ids: ["doc1", "doc2"],
      documents: ["content 1", "content 2"],
      metadatas: [{}, {}],
      embeddings: [
        [0.7, 0.8, 0.9],
        [0.4, 0.5, 0.6],
      ],
    })
  })

  it("includes metadata when provided", async () => {
    const documents: DocumentChunk[] = [
      { id: "doc1", content: "content", metadata: { type: "test" }, embedding: [0.1, 0.2] },
    ]

    await addDocuments(collection, documents, mockConfig)

    expect(collection.add).toHaveBeenCalledWith(
      expect.objectContaining({
        metadatas: [{ type: "test" }],
      })
    )
  })
})

describe("updateDocuments", () => {
  let collection: Collection

  beforeEach(async () => {
    resetChromaClient()
    const client = getChromaClient(mockConfig)
    collection = await getOrCreateCollection(client, "test")
    jest.clearAllMocks()
  })

  it("updates documents with new embeddings", async () => {
    const documents: DocumentChunk[] = [{ id: "doc1", content: "updated content" }]

    await updateDocuments(collection, documents, mockConfig)

    expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
      ["updated content"],
      mockConfig.embeddingConfig,
      mockConfig.apiKey
    )

    expect(collection.update).toHaveBeenCalled()
  })
})

describe("deleteDocuments", () => {
  let collection: Collection

  beforeEach(async () => {
    resetChromaClient()
    const client = getChromaClient(mockConfig)
    collection = await getOrCreateCollection(client, "test")
    jest.clearAllMocks()
  })

  it("deletes documents by IDs", async () => {
    await deleteDocuments(collection, ["doc1", "doc2"])

    expect(collection.delete).toHaveBeenCalledWith({
      ids: ["doc1", "doc2"],
    })
  })
})

describe("queryCollection", () => {
  let collection: Collection

  beforeEach(async () => {
    resetChromaClient()
    const client = getChromaClient(mockConfig)
    collection = await getOrCreateCollection(client, "test")
    jest.clearAllMocks()
  })

  it("queries with generated embedding", async () => {
    const results = await queryCollection(collection, "search query", mockConfig)

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      "search query",
      mockConfig.embeddingConfig,
      mockConfig.apiKey
    )

    expect(results).toHaveLength(2)
  })

  it("returns results with similarity scores", async () => {
    const results = await queryCollection(collection, "query", mockConfig)

    expect(results[0].distance).toBe(0.1)
    expect(results[0].similarity).toBe(0.9)
    expect(results[1].distance).toBe(0.2)
    expect(results[1].similarity).toBe(0.8)
  })

  it("respects nResults option", async () => {
    await queryCollection(collection, "query", mockConfig, { nResults: 10 })

    expect(collection.query).toHaveBeenCalledWith(
      expect.objectContaining({
        nResults: 10,
      })
    )
  })

  it("passes where and whereDocument filters", async () => {
    const where = { type: "test" }
    const whereDocument = { $contains: "keyword" }

    await queryCollection(collection, "query", mockConfig, { where, whereDocument })

    expect(collection.query).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        whereDocument,
      })
    )
  })
})

describe("getDocuments", () => {
  let collection: Collection

  beforeEach(async () => {
    resetChromaClient()
    const client = getChromaClient(mockConfig)
    collection = await getOrCreateCollection(client, "test")
    jest.clearAllMocks()
  })

  it("retrieves documents by IDs", async () => {
    const documents = await getDocuments(collection, ["id1"])

    expect(collection.get).toHaveBeenCalledWith({
      ids: ["id1"],
      include: ["documents", "metadatas", "embeddings"],
    })

    expect(documents).toHaveLength(1)
    expect(documents[0].id).toBe("id1")
    expect(documents[0].content).toBe("content1")
  })
})

describe("upsertDocuments", () => {
  let collection: Collection

  beforeEach(async () => {
    resetChromaClient()
    const client = getChromaClient(mockConfig)
    collection = await getOrCreateCollection(client, "test")
    jest.clearAllMocks()
  })

  it("upserts documents with embeddings", async () => {
    const documents: DocumentChunk[] = [
      { id: "doc1", content: "content", embedding: [0.1, 0.2, 0.3] },
    ]

    await upsertDocuments(collection, documents, mockConfig)

    expect(collection.upsert).toHaveBeenCalled()
  })

  it("generates embeddings when not provided", async () => {
    const documents: DocumentChunk[] = [{ id: "doc1", content: "content" }]

    await upsertDocuments(collection, documents, mockConfig)

    expect(mockGenerateEmbeddings).toHaveBeenCalled()
  })
})

describe("getCollectionCount", () => {
  let collection: Collection

  beforeEach(async () => {
    resetChromaClient()
    const client = getChromaClient(mockConfig)
    collection = await getOrCreateCollection(client, "test")
    jest.clearAllMocks()
  })

  it("returns collection count", async () => {
    const count = await getCollectionCount(collection)

    expect(collection.count).toHaveBeenCalled()
    expect(count).toBe(10)
  })
})

describe("peekCollection", () => {
  let collection: Collection

  beforeEach(async () => {
    resetChromaClient()
    const client = getChromaClient(mockConfig)
    collection = await getOrCreateCollection(client, "test")
    jest.clearAllMocks()
  })

  it("peeks at first documents", async () => {
    const documents = await peekCollection(collection)

    expect(collection.peek).toHaveBeenCalledWith({ limit: 10 })
    expect(documents).toHaveLength(2)
  })

  it("respects custom limit", async () => {
    await peekCollection(collection, 5)

    expect(collection.peek).toHaveBeenCalledWith({ limit: 5 })
  })
})
