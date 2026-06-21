import {
  createRAGRuntimeConfigFromVectorSettings,
  resolveSharedRAGRuntimeSelection,
} from "./rag-runtime"
import {
  resetStorageBackendReadinessRegistryForTest,
  updateStorageBackendReadiness,
} from "@/lib/storage/persistence/backend-readiness"

describe("createRAGRuntimeConfigFromVectorSettings", () => {
  beforeEach(() => {
    resetStorageBackendReadinessRegistryForTest()
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
})
