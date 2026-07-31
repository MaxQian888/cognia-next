import type { RAGRuntimeConfig } from "./rag-runtime"
import {
  composeRAGRuntimeConfig,
  createEmptyRAGSearchMetadata,
  normalizeRAGRetrievalResult,
  resolveRAGCollection,
} from "./consumption-contract"

const baseConfig: RAGRuntimeConfig = {
  vectorStore: {
    provider: "chroma",
    embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
    embeddingApiKey: "base-key",
    native: {},
  },
  defaultCollectionName: "runtime-default",
  topK: 5,
  similarityThreshold: 0.4,
  hybridSearch: { enabled: true, vectorWeight: 0.7, keywordWeight: 0.3 },
  queryExpansion: { enabled: false },
}

describe("resolveRAGCollection", () => {
  it("prefers explicit collection over scene and runtime defaults", () => {
    const resolved = resolveRAGCollection({
      explicitCollectionName: "explicit",
      sceneDefaultCollectionName: "scene-default",
      runtimeDefaultCollectionName: "runtime-default",
    })

    expect(resolved).toEqual(
      expect.objectContaining({
        status: "resolved",
        collectionName: "explicit",
        source: "explicit",
      })
    )
  })

  it('falls back to scene default then runtime default then "default"', () => {
    const sceneResolved = resolveRAGCollection({
      sceneDefaultCollectionName: "scene-default",
      runtimeDefaultCollectionName: "runtime-default",
    })
    expect(sceneResolved.collectionName).toBe("scene-default")
    expect(sceneResolved.source).toBe("scene-default")

    const runtimeResolved = resolveRAGCollection({
      runtimeDefaultCollectionName: "runtime-default",
    })
    expect(runtimeResolved.collectionName).toBe("runtime-default")
    expect(runtimeResolved.source).toBe("runtime-default")

    const fallbackResolved = resolveRAGCollection({})
    expect(fallbackResolved.collectionName).toBe("default")
    expect(fallbackResolved.source).toBe("fallback-default")
  })

  it("returns unavailable when allowlist does not contain resolved collection", () => {
    const resolved = resolveRAGCollection({
      explicitCollectionName: "knowledge",
      availableCollections: ["docs", "faq"],
    })

    expect(resolved).toEqual(
      expect.objectContaining({
        status: "unavailable",
        collectionName: "knowledge",
        degradeReason: "collection_unavailable",
      })
    )
  })

  it("returns empty when no collection candidates exist and fallback is disabled", () => {
    const resolved = resolveRAGCollection({
      allowFallbackDefault: false,
    })

    expect(resolved).toEqual(
      expect.objectContaining({
        status: "empty",
        degradeReason: "no_collection",
      })
    )
  })
})

describe("composeRAGRuntimeConfig", () => {
  it("merges runtime overrides including nested vectorStore fields", () => {
    const merged = composeRAGRuntimeConfig(baseConfig, {
      topK: 8,
      similarityThreshold: 0.6,
      vectorStore: {
        provider: "chroma",
        embeddingConfig: { provider: "openai", model: "text-embedding-3-small" },
        embeddingApiKey: "override-key",
        native: {},
      },
    })

    expect(merged.topK).toBe(8)
    expect(merged.similarityThreshold).toBe(0.6)
    expect(merged.vectorStore.embeddingApiKey).toBe("override-key")
    expect(merged.vectorStore.provider).toBe("chroma")
  })
})

describe("normalizeRAGRetrievalResult", () => {
  it("returns success outcome with normalized metadata for retrieved documents", () => {
    const result = normalizeRAGRetrievalResult({
      query: "test query",
      collectionName: "docs",
      documents: [
        {
          id: "doc-1",
          content: "Document content",
          rerankScore: 0.93,
          metadata: { source: "manual" },
        },
      ],
      formattedContext: "Document content",
      searchMetadata: {
        hybridSearchUsed: true,
        queryExpansionUsed: false,
        rerankingUsed: true,
      },
    })

    expect(result.success).toBe(true)
    expect(result.outcome).toBe("success")
    expect(result.degradeReason).toBe("none")
    expect(result.totalResults).toBe(1)
    expect(result.results?.[0]).toEqual(
      expect.objectContaining({
        content: "Document content",
        similarity: 0.93,
      })
    )
    expect(result.searchMetadata?.hybridSearchUsed).toBe(true)
  })

  it("returns empty outcome when retrieval returns no documents", () => {
    const result = normalizeRAGRetrievalResult({
      query: "missing query",
      collectionName: "docs",
      documents: [],
      formattedContext: "",
      searchMetadata: createEmptyRAGSearchMetadata(),
    })

    expect(result.success).toBe(true)
    expect(result.outcome).toBe("empty")
    expect(result.degradeReason).toBe("empty_results")
    expect(result.results).toEqual([])
  })

  it("returns quality-filtered outcome when all candidates are filtered", () => {
    const result = normalizeRAGRetrievalResult({
      query: "strict query",
      collectionName: "docs",
      documents: [],
      formattedContext: "",
      searchMetadata: createEmptyRAGSearchMetadata(),
      qualityFilteredCount: 3,
      threshold: 0.8,
    })

    expect(result.outcome).toBe("quality_filtered")
    expect(result.degradeReason).toBe("quality_filtered")
    expect(result.diagnostics?.qualityFilteredCount).toBe(3)
  })

  it("returns degraded outcome for runtime errors", () => {
    const result = normalizeRAGRetrievalResult({
      query: "broken query",
      collectionName: "docs",
      documents: [],
      formattedContext: "",
      searchMetadata: createEmptyRAGSearchMetadata(),
      error: new Error("runtime failed"),
    })

    expect(result.success).toBe(false)
    expect(result.outcome).toBe("degraded")
    expect(result.degradeReason).toBe("runtime_error")
    expect(result.error).toBe("runtime failed")
  })
})
