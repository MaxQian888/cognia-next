/**
 * Tests for Milvus Vector Database Client
 *
 * These tests verify the Milvus client functions work correctly with the mock.
 * The mock provides in-memory storage for testing without a real Milvus instance.
 */

import { MilvusClient, DataType } from "@zilliz/milvus2-sdk-node"
import {
  getMilvusClient,
  resetMilvusClient,
  milvusCollectionExists,
  createMilvusCollection,
  deleteMilvusCollection,
  listMilvusCollections,
  upsertMilvusDocuments,
  insertMilvusDocuments,
  queryMilvus,
  searchMilvusByVector,
  deleteMilvusDocuments,
  deleteMilvusByFilter,
  getMilvusDocuments,
  queryMilvusByFilter,
  countMilvusDocuments,
  createMilvusIndex,
  dropMilvusIndex,
  loadMilvusCollection,
  releaseMilvusCollection,
  flushMilvusCollection,
  getMilvusLoadingProgress,
  compactMilvusCollection,
  createMilvusPartition,
  dropMilvusPartition,
  listMilvusPartitions,
  hybridSearchMilvus,
  type MilvusConfig,
  type MilvusDocument,
} from "./milvus-client"

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

// Import mock reset function
const { resetMockState } = jest.requireMock("@zilliz/milvus2-sdk-node")

const mockConfig: MilvusConfig = {
  address: "localhost:19530",
  token: "test-token",
  collectionName: "test-collection",
  embeddingConfig: {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  embeddingApiKey: "test-embedding-key",
}

describe("getMilvusClient", () => {
  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
  })

  it("creates client with address", () => {
    const client = getMilvusClient({ address: "localhost:19530" })
    expect(client).toBeDefined()
  })

  it("creates client with all options", () => {
    const client = getMilvusClient({
      address: "milvus.example.com:19530",
      token: "api-token",
      username: "user",
      password: "pass",
      ssl: true,
    })

    expect(client).toBeDefined()
  })

  it("reuses existing client instance", () => {
    resetMilvusClient()
    const client1 = getMilvusClient({ address: "localhost:19530" })
    const client2 = getMilvusClient({ address: "localhost:19530" })
    expect(client1).toBe(client2)
  })
})

describe("resetMilvusClient", () => {
  beforeEach(() => {
    resetMockState()
  })

  it("resets the client instance", () => {
    resetMilvusClient()
    const client1 = getMilvusClient({ address: "localhost:19530" })
    resetMilvusClient()
    const client2 = getMilvusClient({ address: "localhost:19530" })
    expect(client1).not.toBe(client2)
  })
})

describe("milvusCollectionExists", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("returns false when collection does not exist", async () => {
    const exists = await milvusCollectionExists(client, "nonexistent")
    expect(exists).toBe(false)
  })

  it("returns true when collection exists", async () => {
    await createMilvusCollection(client, "test-collection", 1536)
    const exists = await milvusCollectionExists(client, "test-collection")
    expect(exists).toBe(true)
  })
})

describe("createMilvusCollection", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("creates collection successfully", async () => {
    await expect(createMilvusCollection(client, "new-collection", 1536)).resolves.not.toThrow()
    const exists = await milvusCollectionExists(client, "new-collection")
    expect(exists).toBe(true)
  })

  it("creates collection with custom options", async () => {
    await expect(
      createMilvusCollection(client, "custom-collection", 768, {
        metricType: "L2",
        description: "Test collection",
      })
    ).resolves.not.toThrow()
  })

  it("skips creation if collection exists", async () => {
    await createMilvusCollection(client, "existing", 1536)
    await expect(createMilvusCollection(client, "existing", 1536)).resolves.not.toThrow()
  })
})

describe("deleteMilvusCollection", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("deletes existing collection", async () => {
    await createMilvusCollection(client, "to-delete", 1536)
    await deleteMilvusCollection(client, "to-delete")
    const exists = await milvusCollectionExists(client, "to-delete")
    expect(exists).toBe(false)
  })

  it("does nothing for nonexistent collection", async () => {
    await expect(deleteMilvusCollection(client, "nonexistent")).resolves.not.toThrow()
  })
})

describe("listMilvusCollections", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("lists all collections", async () => {
    await createMilvusCollection(client, "collection1", 1536)
    await createMilvusCollection(client, "collection2", 768)

    const collections = await listMilvusCollections(client)
    expect(Array.isArray(collections)).toBe(true)
    expect(collections.length).toBeGreaterThanOrEqual(2)
  })

  it("returns empty array when no collections", async () => {
    const collections = await listMilvusCollections(client)
    expect(Array.isArray(collections)).toBe(true)
  })
})

describe("upsertMilvusDocuments", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("upserts documents with provided embeddings", async () => {
    await createMilvusCollection(client, "test-collection", 3)

    const documents: MilvusDocument[] = [
      { id: "doc1", content: "content 1", embedding: [0.1, 0.2, 0.3] },
      { id: "doc2", content: "content 2", embedding: [0.4, 0.5, 0.6] },
    ]

    await expect(
      upsertMilvusDocuments(client, "test-collection", documents, mockConfig)
    ).resolves.not.toThrow()
  })

  it("generates embeddings for documents without them", async () => {
    await createMilvusCollection(client, "test-collection", 3)

    const documents: MilvusDocument[] = [
      { id: "doc1", content: "content 1" },
      { id: "doc2", content: "content 2" },
    ]

    await expect(
      upsertMilvusDocuments(client, "test-collection", documents, mockConfig)
    ).resolves.not.toThrow()
  })
})

describe("insertMilvusDocuments", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("inserts documents", async () => {
    await createMilvusCollection(client, "test-collection", 3)

    const documents: MilvusDocument[] = [
      { id: "doc1", content: "content 1", embedding: [0.1, 0.2, 0.3] },
    ]

    await expect(
      insertMilvusDocuments(client, "test-collection", documents, mockConfig)
    ).resolves.not.toThrow()
  })
})

describe("queryMilvus", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("queries and returns results array", async () => {
    await createMilvusCollection(client, "test-collection", 3)

    const results = await queryMilvus(client, "test-collection", "search query", mockConfig)
    expect(Array.isArray(results)).toBe(true)
  })

  it("respects topK option", async () => {
    await createMilvusCollection(client, "test-collection", 3)

    const results = await queryMilvus(client, "test-collection", "query", mockConfig, { topK: 10 })
    expect(Array.isArray(results)).toBe(true)
  })
})

describe("searchMilvusByVector", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("searches with provided vector", async () => {
    await createMilvusCollection(client, "test-collection", 3)

    const vector = [0.1, 0.2, 0.3]
    const results = await searchMilvusByVector(client, "test-collection", vector)
    expect(Array.isArray(results)).toBe(true)
  })
})

describe("deleteMilvusDocuments", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("deletes documents by IDs", async () => {
    await createMilvusCollection(client, "test-collection", 3)
    await expect(
      deleteMilvusDocuments(client, "test-collection", ["doc1", "doc2"])
    ).resolves.not.toThrow()
  })
})

describe("deleteMilvusByFilter", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("deletes by filter expression", async () => {
    await expect(
      deleteMilvusByFilter(client, "test-collection", 'type == "obsolete"')
    ).resolves.not.toThrow()
  })
})

describe("getMilvusDocuments", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("retrieves documents by IDs", async () => {
    await createMilvusCollection(client, "test-collection", 3)
    const documents = await getMilvusDocuments(client, "test-collection", ["doc1"])
    expect(Array.isArray(documents)).toBe(true)
  })
})

describe("queryMilvusByFilter", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("queries with filter expression", async () => {
    const results = await queryMilvusByFilter(client, "test-collection", 'type == "document"')
    expect(Array.isArray(results)).toBe(true)
  })
})

describe("countMilvusDocuments", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("counts documents in collection", async () => {
    const count = await countMilvusDocuments(client, "test-collection")
    expect(typeof count).toBe("number")
  })
})

describe("createMilvusIndex", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("creates index with default options", async () => {
    await expect(createMilvusIndex(client, "test-collection", "vector")).resolves.not.toThrow()
  })

  it("creates index with custom options", async () => {
    await expect(
      createMilvusIndex(client, "test-collection", "vector", {
        indexType: "IVF_FLAT",
        metricType: "L2",
      })
    ).resolves.not.toThrow()
  })
})

describe("dropMilvusIndex", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("drops index", async () => {
    await expect(dropMilvusIndex(client, "test-collection", "vector")).resolves.not.toThrow()
  })
})

describe("loadMilvusCollection", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("loads collection", async () => {
    await expect(loadMilvusCollection(client, "test-collection")).resolves.not.toThrow()
  })
})

describe("releaseMilvusCollection", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("releases collection", async () => {
    await expect(releaseMilvusCollection(client, "test-collection")).resolves.not.toThrow()
  })
})

describe("flushMilvusCollection", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("flushes collection", async () => {
    await expect(flushMilvusCollection(client, "test-collection")).resolves.not.toThrow()
  })
})

describe("getMilvusLoadingProgress", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("returns loading progress", async () => {
    await createMilvusCollection(client, "test-collection", 3)
    const progress = await getMilvusLoadingProgress(client, "test-collection")
    expect(typeof progress).toBe("number")
  })
})

describe("compactMilvusCollection", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("compacts collection", async () => {
    await expect(compactMilvusCollection(client, "test-collection")).resolves.not.toThrow()
  })
})

describe("createMilvusPartition", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("creates partition", async () => {
    await expect(
      createMilvusPartition(client, "test-collection", "new-partition")
    ).resolves.not.toThrow()
  })
})

describe("dropMilvusPartition", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("drops partition", async () => {
    await expect(
      dropMilvusPartition(client, "test-collection", "old-partition")
    ).resolves.not.toThrow()
  })
})

describe("listMilvusPartitions", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("lists partitions", async () => {
    const partitions = await listMilvusPartitions(client, "test-collection")
    expect(Array.isArray(partitions)).toBe(true)
  })
})

describe("hybridSearchMilvus", () => {
  let client: MilvusClient

  beforeEach(() => {
    resetMilvusClient()
    resetMockState()
    client = getMilvusClient({ address: "localhost:19530" })
  })

  it("performs search for single query", async () => {
    await createMilvusCollection(client, "test-collection", 3)

    const results = await hybridSearchMilvus(client, "test-collection", [
      { vector: [0.1, 0.2, 0.3] },
    ])

    expect(Array.isArray(results)).toBe(true)
  })

  it("performs hybrid search for multiple queries", async () => {
    await createMilvusCollection(client, "test-collection", 3)

    const results = await hybridSearchMilvus(client, "test-collection", [
      { vector: [0.1, 0.2, 0.3], weight: 0.7 },
      { vector: [0.4, 0.5, 0.6], weight: 0.3 },
    ])

    expect(Array.isArray(results)).toBe(true)
  })
})

describe("DataType export", () => {
  it("exports DataType enum", () => {
    expect(DataType).toBeDefined()
    expect(DataType.VarChar).toBe(21)
    expect(DataType.FloatVector).toBe(101)
  })
})
