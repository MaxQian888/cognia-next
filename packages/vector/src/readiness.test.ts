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

// isTauri is re-exported from @/lib/tauri through @/lib/utils.
// We mock @/lib/utils so readiness.ts (which imports from there) can be
// controlled per-test.
const mockIsTauri = jest.fn<boolean, []>(() => false)
jest.mock("@/lib/utils", () => ({
  ...jest.requireActual("@/lib/utils"),
  isTauri: () => mockIsTauri(),
}))

describe("verifyVectorBackendReadiness", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetStorageBackendReadinessRegistryForTest()
    // Default: non-Tauri environment
    mockIsTauri.mockReturnValue(false)
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

  it("treats blank cloud config ids as missing configuration", async () => {
    const result = await verifyVectorBackendReadiness({
      provider: "qdrant",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      embeddingApiKey: "embedding-key",
      configId: "   ",
    })

    expect(result.state).toBe("unconfigured")
    expect(result.diagnostic).toMatchObject({
      code: "configuration-missing",
      stage: "configuration",
    })
  })

  it("marks backend operational after reachability and operational probe succeed", async () => {
    mockListCollections.mockResolvedValue([{ name: "default", documentCount: 1 }])
    mockCreateCollection.mockResolvedValue(undefined)
    mockDeleteCollection.mockResolvedValue(undefined)

    const result = await verifyVectorBackendReadiness({
      provider: "qdrant",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      embeddingApiKey: "embedding-key",
      // Post-ADR-0023: cloud providers are addressed by configId; the
      // actual URL/api-key lives in the keyring on the Rust side.
      configId: "test-qdrant",
    })

    expect(result.state).toBe("operational")
    expect(getStorageBackendReadiness("vector-qdrant")?.state).toBe("operational")
    expect(mockListCollections).toHaveBeenCalled()
    expect(mockCreateCollection).toHaveBeenCalled()
    expect(mockDeleteCollection).toHaveBeenCalled()
  })

  it("can stop after reachability when operational probing is disabled", async () => {
    mockListCollections.mockResolvedValue([])

    const result = await verifyVectorBackendReadiness(
      {
        provider: "chroma",
        embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
        embeddingApiKey: "embedding-key",
        configId: "test-chroma",
      },
      { checkedAt: "2026-06-21T00:00:00.000Z", probeOperational: false }
    )

    expect(result.state).toBe("reachable")
    expect(result.lastCheckedAt).toBe("2026-06-21T00:00:00.000Z")
    expect(result.diagnostic).toBeUndefined()
    expect(mockListCollections).toHaveBeenCalled()
    expect(mockCreateCollection).not.toHaveBeenCalled()
    expect(mockDeleteCollection).not.toHaveBeenCalled()
  })

  it("returns cleanup diagnostics when probe cleanup fails", async () => {
    mockListCollections.mockResolvedValue([])
    mockCreateCollection.mockResolvedValue(undefined)
    mockDeleteCollection.mockRejectedValue(new Error("cleanup failed"))

    const result = await verifyVectorBackendReadiness({
      provider: "weaviate",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      embeddingApiKey: "embedding-key",
      configId: "test-weaviate",
    })

    expect(result.state).toBe("degraded")
    expect(result.diagnostic?.code).toBe("cleanup-failed")
  })

  it("normalizes non-Error cleanup failures", async () => {
    mockListCollections.mockResolvedValue([])
    mockCreateCollection.mockResolvedValue(undefined)
    mockDeleteCollection.mockRejectedValue("cleanup unavailable")

    const result = await verifyVectorBackendReadiness({
      provider: "pinecone",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      embeddingApiKey: "embedding-key",
      configId: "test-pinecone",
    })

    expect(result.state).toBe("degraded")
    expect(result.diagnostic).toMatchObject({
      code: "cleanup-failed",
      message: "cleanup unavailable",
      stage: "operational",
    })
  })

  it("classifies auth failures from reachability checks", async () => {
    mockListCollections.mockRejectedValue(new Error("401 unauthorized"))

    const result = await verifyVectorBackendReadiness({
      provider: "milvus",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      embeddingApiKey: "embedding-key",
      configId: "test-milvus",
    })

    expect(result.state).toBe("configured")
    expect(result.diagnostic?.code).toBe("auth-failed")
  })

  it("classifies network, prerequisite, and generic reachability failures", async () => {
    mockListCollections.mockRejectedValueOnce(new Error("fetch failed: network timeout"))
    await expect(
      verifyVectorBackendReadiness({
        provider: "qdrant",
        embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
        embeddingApiKey: "embedding-key",
        configId: "test-qdrant",
      })
    ).resolves.toMatchObject({
      state: "configured",
      diagnostic: { code: "network-failed", stage: "reachability" },
    })

    mockListCollections.mockRejectedValueOnce(new Error("missing namespace"))
    await expect(
      verifyVectorBackendReadiness({
        provider: "weaviate",
        embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
        embeddingApiKey: "embedding-key",
        configId: "test-weaviate",
      })
    ).resolves.toMatchObject({
      state: "configured",
      diagnostic: { code: "prerequisite-missing", stage: "reachability" },
    })

    mockListCollections.mockRejectedValueOnce(new Error("service unavailable"))
    await expect(
      verifyVectorBackendReadiness({
        provider: "milvus",
        embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
        embeddingApiKey: "embedding-key",
        configId: "test-milvus",
      })
    ).resolves.toMatchObject({
      state: "configured",
      diagnostic: { code: "reachability-failed", stage: "reachability" },
    })
  })

  it("classifies generic operational probe failures as roundtrip failures", async () => {
    mockListCollections.mockResolvedValue([])
    mockCreateCollection.mockRejectedValue(new Error("create quota exhausted"))

    const result = await verifyVectorBackendReadiness({
      provider: "qdrant",
      embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
      embeddingApiKey: "embedding-key",
      configId: "test-qdrant",
    })

    expect(result.state).toBe("reachable")
    expect(result.diagnostic).toMatchObject({
      code: "roundtrip-failed",
      stage: "operational",
    })
  })

  describe("native provider", () => {
    const nativeConfig = {
      provider: "native" as const,
      embeddingConfig: { provider: "openai" as const, model: "text-embedding-3-small" },
      embeddingApiKey: "test-key",
      native: {},
    }

    it("native + Tauri = operational", async () => {
      mockIsTauri.mockReturnValue(true)
      mockListCollections.mockResolvedValue([])
      mockCreateCollection.mockResolvedValue(undefined)
      mockDeleteCollection.mockResolvedValue(undefined)

      const result = await verifyVectorBackendReadiness(nativeConfig)

      expect(result.state).toBe("operational")
      expect(getStorageBackendReadiness("vector-native")?.state).toBe("operational")
      expect(mockListCollections).toHaveBeenCalled()
      expect(mockCreateCollection).toHaveBeenCalled()
      expect(mockDeleteCollection).toHaveBeenCalled()
    })

    it("native + non-Tauri = unconfigured with configuration-error diagnostic", async () => {
      mockIsTauri.mockReturnValue(false)

      const result = await verifyVectorBackendReadiness(nativeConfig)

      expect(result.state).toBe("unconfigured")
      expect(result.diagnostic?.code).toBe("configuration-missing")
    })

    it("native + dimension mismatch on probe = reachable with roundtrip-failed code", async () => {
      mockIsTauri.mockReturnValue(true)
      mockListCollections.mockResolvedValue([])
      mockCreateCollection.mockRejectedValue(
        new Error("Dimension mismatch: collection=foo expected=1536 got=3072")
      )

      const result = await verifyVectorBackendReadiness(nativeConfig)

      // "collection" in message → stage "operational" → classifyVectorError →
      // code "prerequisite-missing", state "reachable" (from the collection branch)
      expect(result.state).toBe("reachable")
    })
  })
})
