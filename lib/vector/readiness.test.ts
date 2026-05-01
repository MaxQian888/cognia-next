import {
  getStorageBackendReadiness,
  resetStorageBackendReadinessRegistryForTest,
} from "@/lib/storage/persistence/backend-readiness"
import { verifyVectorBackendReadiness } from "./readiness"

const mockListCollections = jest.fn()
const mockCreateCollection = jest.fn()
const mockDeleteCollection = jest.fn()

jest.mock("./store", () => ({
  createVectorStore: jest.fn(() => ({
    provider: "qdrant",
    listCollections: (...args: unknown[]) => mockListCollections(...args),
    createCollection: (...args: unknown[]) => mockCreateCollection(...args),
    deleteCollection: (...args: unknown[]) => mockDeleteCollection(...args),
  })),
}))

describe("verifyVectorBackendReadiness", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetStorageBackendReadinessRegistryForTest()
  })

  it("returns unconfigured when required provider config is missing", async () => {
    const result = await verifyVectorBackendReadiness({
      provider: "pinecone",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      embeddingApiKey: "embedding-key",
      pineconeApiKey: "",
      pineconeIndexName: "",
    })

    expect(result.state).toBe("unconfigured")
    expect(result.diagnostic?.code).toBe("configuration-missing")
  })

  it("marks backend operational after reachability and operational probe succeed", async () => {
    mockListCollections.mockResolvedValue([{ name: "default", documentCount: 1 }])
    mockCreateCollection.mockResolvedValue(undefined)
    mockDeleteCollection.mockResolvedValue(undefined)

    const result = await verifyVectorBackendReadiness({
      provider: "qdrant",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      embeddingApiKey: "embedding-key",
      qdrantUrl: "http://localhost:6333",
    })

    expect(result.state).toBe("operational")
    expect(getStorageBackendReadiness("vector-qdrant")?.state).toBe("operational")
    expect(mockListCollections).toHaveBeenCalled()
    expect(mockCreateCollection).toHaveBeenCalled()
    expect(mockDeleteCollection).toHaveBeenCalled()
  })

  it("returns cleanup diagnostics when probe cleanup fails", async () => {
    mockListCollections.mockResolvedValue([])
    mockCreateCollection.mockResolvedValue(undefined)
    mockDeleteCollection.mockRejectedValue(new Error("cleanup failed"))

    const result = await verifyVectorBackendReadiness({
      provider: "weaviate",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      embeddingApiKey: "embedding-key",
      weaviateUrl: "http://localhost:8080",
    })

    expect(result.state).toBe("degraded")
    expect(result.diagnostic?.code).toBe("cleanup-failed")
  })

  it("classifies auth failures from reachability checks", async () => {
    mockListCollections.mockRejectedValue(new Error("401 unauthorized"))

    const result = await verifyVectorBackendReadiness({
      provider: "milvus",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      embeddingApiKey: "embedding-key",
      milvusAddress: "localhost:19530",
      milvusToken: "bad-token",
    })

    expect(result.state).toBe("configured")
    expect(result.diagnostic?.code).toBe("auth-failed")
  })
})
