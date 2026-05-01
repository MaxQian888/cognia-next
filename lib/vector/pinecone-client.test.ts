/**
 * Tests for Pinecone Vector Database Client
 */

import { Pinecone } from "@pinecone-database/pinecone"
import {
  getPineconeClient,
  resetPineconeClient,
  getPineconeIndex,
  listPineconeIndexes,
  createPineconeIndex,
  describePineconeIndex,
  configurePineconeIndex,
  deletePineconeIndex,
  upsertDocuments,
  queryPinecone,
  deleteDocuments,
  deleteAllDocuments,
  fetchDocuments,
  getIndexStats,
  type PineconeConfig,
  type PineconeDocument,
} from "./pinecone-client"

// Mock Pinecone
const mockIndex = {
  upsert: jest.fn().mockResolvedValue(undefined),
  query: jest.fn().mockResolvedValue({
    matches: [
      { id: "doc1", score: 0.95, metadata: { content: "result 1" } },
      { id: "doc2", score: 0.85, metadata: { content: "result 2" } },
    ],
  }),
  deleteMany: jest.fn().mockResolvedValue(undefined),
  deleteAll: jest.fn().mockResolvedValue(undefined),
  fetch: jest.fn().mockResolvedValue({
    records: {
      doc1: { id: "doc1", values: [0.1, 0.2], metadata: { content: "content 1" } },
    },
  }),
  describeIndexStats: jest.fn().mockResolvedValue({
    totalRecordCount: 1000,
    dimension: 1536,
    namespaces: {
      default: { recordCount: 500 },
      other: { recordCount: 500 },
    },
  }),
  namespace: jest.fn().mockReturnThis(),
}

jest.mock("@pinecone-database/pinecone", () => ({
  Pinecone: jest.fn().mockImplementation(() => ({
    index: jest.fn().mockReturnValue(mockIndex),
    listIndexes: jest.fn().mockResolvedValue({
      indexes: [
        {
          name: "index1",
          dimension: 1536,
          metric: "cosine",
          host: "index1.pinecone.io",
          deletionProtection: "disabled",
          status: { ready: true, state: "Ready" },
        },
      ],
    }),
    createIndex: jest.fn().mockResolvedValue(undefined),
    describeIndex: jest.fn().mockResolvedValue({
      name: "test-index",
      dimension: 1536,
      metric: "cosine",
      host: "test.pinecone.io",
      deletionProtection: "disabled",
      status: { ready: true, state: "Ready" },
    }),
    configureIndex: jest.fn().mockResolvedValue(undefined),
    deleteIndex: jest.fn().mockResolvedValue(undefined),
  })),
}))

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

const mockConfig: PineconeConfig = {
  apiKey: "test-api-key",
  indexName: "test-index",
  namespace: "test-namespace",
  embeddingConfig: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  embeddingApiKey: "test-embedding-key",
}

describe("getPineconeClient", () => {
  beforeEach(() => {
    resetPineconeClient()
    jest.clearAllMocks()
  })

  it("creates client with API key", () => {
    const client = getPineconeClient("test-api-key")
    expect(client).toBeDefined()
    expect(Pinecone).toHaveBeenCalledWith({ apiKey: "test-api-key" })
  })

  it("reuses existing client instance", () => {
    resetPineconeClient()
    getPineconeClient("test-api-key")
    getPineconeClient("test-api-key")
    // Should only create one instance when called twice without reset
    expect(Pinecone).toHaveBeenCalled()
  })
})

describe("resetPineconeClient", () => {
  it("resets the client instance", () => {
    resetPineconeClient()
    getPineconeClient("test-api-key")
    resetPineconeClient()
    getPineconeClient("test-api-key")
    // After reset, new instance should be created
    expect(Pinecone).toHaveBeenCalled()
  })
})

describe("getPineconeIndex", () => {
  let client: Pinecone

  beforeEach(() => {
    resetPineconeClient()
    client = getPineconeClient("test-api-key")
    jest.clearAllMocks()
  })

  it("returns index by name", () => {
    const index = getPineconeIndex(client, "my-index")
    expect(client.index).toHaveBeenCalledWith("my-index")
    expect(index).toBeDefined()
  })
})

describe("listPineconeIndexes", () => {
  let client: Pinecone

  beforeEach(() => {
    resetPineconeClient()
    client = getPineconeClient("test-api-key")
    jest.clearAllMocks()
  })

  it("lists all indexes", async () => {
    const indexes = await listPineconeIndexes(client)

    expect(indexes).toHaveLength(1)
    expect(indexes[0].name).toBe("index1")
    expect(indexes[0].dimension).toBe(1536)
    expect(indexes[0].metric).toBe("cosine")
  })

  it("includes status information", async () => {
    const indexes = await listPineconeIndexes(client)

    expect(indexes[0].status.ready).toBe(true)
    expect(indexes[0].status.state).toBe("Ready")
  })
})

describe("createPineconeIndex", () => {
  let client: Pinecone

  beforeEach(() => {
    resetPineconeClient()
    client = getPineconeClient("test-api-key")
    jest.clearAllMocks()
  })

  it("creates index with default options", async () => {
    await createPineconeIndex(client, "new-index", 1536)

    expect(client.createIndex).toHaveBeenCalledWith({
      name: "new-index",
      dimension: 1536,
      metric: "cosine",
      spec: {
        serverless: {
          cloud: "aws",
          region: "us-east-1",
        },
      },
      waitUntilReady: true,
      suppressConflicts: false,
      deletionProtection: "disabled",
      tags: undefined,
    })
  })

  it("creates index with custom options", async () => {
    await createPineconeIndex(client, "new-index", 768, {
      metric: "dotproduct",
      cloud: "gcp",
      region: "us-central1",
      deletionProtection: "enabled",
      tags: { env: "production" },
    })

    expect(client.createIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "dotproduct",
        spec: {
          serverless: {
            cloud: "gcp",
            region: "us-central1",
          },
        },
        deletionProtection: "enabled",
        tags: { env: "production" },
      })
    )
  })

  it("can suppress conflicts", async () => {
    await createPineconeIndex(client, "existing-index", 1536, {
      suppressConflicts: true,
    })

    expect(client.createIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressConflicts: true,
      })
    )
  })
})

describe("describePineconeIndex", () => {
  let client: Pinecone

  beforeEach(() => {
    resetPineconeClient()
    client = getPineconeClient("test-api-key")
    jest.clearAllMocks()
  })

  it("returns index info", async () => {
    const info = await describePineconeIndex(client, "test-index")

    expect(info.name).toBe("test-index")
    expect(info.dimension).toBe(1536)
    expect(info.metric).toBe("cosine")
    expect(info.host).toBe("test.pinecone.io")
    expect(info.status.ready).toBe(true)
  })
})

describe("configurePineconeIndex", () => {
  let client: Pinecone

  beforeEach(() => {
    resetPineconeClient()
    client = getPineconeClient("test-api-key")
    jest.clearAllMocks()
  })

  it("configures deletion protection", async () => {
    await configurePineconeIndex(client, "test-index", {
      deletionProtection: "enabled",
    })

    expect(client.configureIndex).toHaveBeenCalledWith({
      name: "test-index",
      deletionProtection: "enabled",
      tags: undefined,
    })
  })

  it("configures tags", async () => {
    await configurePineconeIndex(client, "test-index", {
      tags: { env: "staging" },
    })

    expect(client.configureIndex).toHaveBeenCalledWith({
      name: "test-index",
      deletionProtection: undefined,
      tags: { env: "staging" },
    })
  })
})

describe("deletePineconeIndex", () => {
  let client: Pinecone

  beforeEach(() => {
    resetPineconeClient()
    client = getPineconeClient("test-api-key")
    jest.clearAllMocks()
  })

  it("deletes index by name", async () => {
    await deletePineconeIndex(client, "old-index")

    expect(client.deleteIndex).toHaveBeenCalledWith("old-index")
  })
})

describe("upsertDocuments", () => {
  beforeEach(() => {
    resetPineconeClient()
    jest.clearAllMocks()
    mockIndex.upsert.mockClear()
    mockIndex.namespace.mockClear()
  })

  it("upserts documents with provided embeddings", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    const documents: PineconeDocument[] = [
      { id: "doc1", content: "content 1", embedding: [0.1, 0.2, 0.3] },
      { id: "doc2", content: "content 2", embedding: [0.4, 0.5, 0.6] },
    ]

    await upsertDocuments(index, documents, mockConfig)

    expect(mockIndex.namespace).toHaveBeenCalledWith("test-namespace")
    expect(mockIndex.upsert).toHaveBeenCalled()
  })

  it("generates embeddings for documents without them", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    const documents: PineconeDocument[] = [
      { id: "doc1", content: "content 1" },
      { id: "doc2", content: "content 2" },
    ]

    await upsertDocuments(index, documents, mockConfig)

    expect(mockGenerateEmbeddings).toHaveBeenCalledWith(
      ["content 1", "content 2"],
      mockConfig.embeddingConfig,
      mockConfig.embeddingApiKey
    )
  })

  it("includes metadata in vectors", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    const documents: PineconeDocument[] = [
      {
        id: "doc1",
        content: "content",
        metadata: { type: "test" },
        embedding: [0.1, 0.2, 0.3],
      },
    ]

    await upsertDocuments(index, documents, mockConfig)

    expect(mockIndex.upsert).toHaveBeenCalledWith({
      records: [
        {
          id: "doc1",
          values: [0.1, 0.2, 0.3],
          metadata: { content: "content", type: "test" },
        },
      ],
    })
  })

  it("batches large document sets", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    const documents: PineconeDocument[] = Array.from({ length: 150 }, (_, i) => ({
      id: `doc${i}`,
      content: `content ${i}`,
      embedding: [0.1, 0.2, 0.3],
    }))

    await upsertDocuments(index, documents, mockConfig)

    expect(mockIndex.upsert).toHaveBeenCalledTimes(2)
  })

  it("uses default namespace when not specified", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    const configWithoutNamespace = { ...mockConfig, namespace: undefined }
    const documents: PineconeDocument[] = [
      { id: "doc1", content: "content", embedding: [0.1, 0.2] },
    ]

    await upsertDocuments(index, documents, configWithoutNamespace)

    expect(mockIndex.namespace).toHaveBeenCalledWith("__default__")
    expect(mockIndex.upsert).toHaveBeenCalled()
  })
})

describe("queryPinecone", () => {
  beforeEach(() => {
    resetPineconeClient()
    jest.clearAllMocks()
    mockIndex.query.mockClear()
  })

  it("queries with generated embedding", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    const results = await queryPinecone(index, "search query", mockConfig)

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      "search query",
      mockConfig.embeddingConfig,
      mockConfig.embeddingApiKey
    )

    expect(results).toHaveLength(2)
  })

  it("returns results with scores", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    const results = await queryPinecone(index, "query", mockConfig)

    expect(results[0].id).toBe("doc1")
    expect(results[0].score).toBe(0.95)
    expect(results[0].content).toBe("result 1")
  })

  it("respects topK option", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    await queryPinecone(index, "query", mockConfig, { topK: 10 })

    expect(mockIndex.query).toHaveBeenCalledWith(
      expect.objectContaining({
        topK: 10,
      })
    )
  })

  it("passes filter option", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    const filter = { type: { $eq: "document" } }

    await queryPinecone(index, "query", mockConfig, { filter })

    expect(mockIndex.query).toHaveBeenCalledWith(
      expect.objectContaining({
        filter,
      })
    )
  })
})

describe("deleteDocuments", () => {
  beforeEach(() => {
    resetPineconeClient()
    jest.clearAllMocks()
    mockIndex.deleteMany.mockClear()
  })

  it("deletes documents by IDs", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    await deleteDocuments(index, ["doc1", "doc2"])

    expect(mockIndex.deleteMany).toHaveBeenCalledWith(["doc1", "doc2"])
  })

  it("uses namespace when provided", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    await deleteDocuments(index, ["doc1"], "my-namespace")

    expect(mockIndex.namespace).toHaveBeenCalledWith("my-namespace")
  })
})

describe("deleteAllDocuments", () => {
  beforeEach(() => {
    resetPineconeClient()
    jest.clearAllMocks()
    mockIndex.deleteAll.mockClear()
  })

  it("deletes all documents", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    await deleteAllDocuments(index)

    expect(mockIndex.namespace).toHaveBeenCalledWith("__default__")
    expect(mockIndex.deleteAll).toHaveBeenCalled()
  })

  it("uses namespace when provided", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    await deleteAllDocuments(index, "my-namespace")

    expect(mockIndex.namespace).toHaveBeenCalledWith("my-namespace")
  })
})

describe("fetchDocuments", () => {
  beforeEach(() => {
    resetPineconeClient()
    jest.clearAllMocks()
    mockIndex.fetch.mockClear()
  })

  it("fetches documents by IDs", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    const documents = await fetchDocuments(index, ["doc1"])

    expect(mockIndex.namespace).toHaveBeenCalledWith("__default__")
    expect(mockIndex.fetch).toHaveBeenCalledWith({ ids: ["doc1"] })
    expect(documents).toHaveLength(1)
    expect(documents[0].id).toBe("doc1")
    expect(documents[0].content).toBe("content 1")
  })

  it("uses namespace when provided", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    await fetchDocuments(index, ["doc1"], "my-namespace")

    expect(mockIndex.namespace).toHaveBeenCalledWith("my-namespace")
  })
})

describe("getIndexStats", () => {
  beforeEach(() => {
    resetPineconeClient()
    jest.clearAllMocks()
    mockIndex.describeIndexStats.mockClear()
  })

  it("returns index statistics", async () => {
    const client = getPineconeClient("test-api-key")
    const index = getPineconeIndex(client, "test-index")

    const stats = await getIndexStats(index)

    expect(stats.totalVectorCount).toBe(1000)
    expect(stats.dimension).toBe(1536)
    expect(stats.namespaces.default.vectorCount).toBe(500)
    expect(stats.namespaces.other.vectorCount).toBe(500)
  })
})
