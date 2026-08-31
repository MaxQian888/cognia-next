import type { TwinRuntimeSettings } from "@/types/twin"
import { DEFAULT_TWIN_RUNTIME_SETTINGS } from "@/types/twin"
import {
  buildTwinRuntimeAdapters,
  deriveTwinVectorStoreConfig,
  tryBuildTwinDeps,
} from "./build-deps"

jest.mock("@/lib/db/twin-runtime-settings", () => ({
  getTwinRuntimeSettings: jest.fn(),
}))

jest.mock("@cognia/vector/store", () => ({
  createVectorStore: jest.fn().mockReturnValue({ provider: "qdrant" }),
}))

jest.mock("@/lib/twin/distill/llm", () => ({
  createLlmClient: jest.fn().mockReturnValue({ complete: jest.fn() }),
  createTwinLanguageModel: jest.fn().mockResolvedValue({ __model: true }),
}))

const { getTwinRuntimeSettings } = jest.requireMock("@/lib/db/twin-runtime-settings")
const { createVectorStore } = jest.requireMock("@cognia/vector/store")
const { createLlmClient } = jest.requireMock("@/lib/twin/distill/llm")
const { createTwinLanguageModel } = jest.requireMock("@/lib/twin/distill/llm")

function settings(patch: Partial<TwinRuntimeSettings> = {}): TwinRuntimeSettings {
  return {
    ...DEFAULT_TWIN_RUNTIME_SETTINGS,
    workerEnabled: true,
    embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, apiKey: "k" },
    ...patch,
  }
}

describe("tryBuildTwinDeps", () => {
  beforeEach(() => jest.resetAllMocks())

  it("returns undefined when worker is disabled", async () => {
    getTwinRuntimeSettings.mockResolvedValue(settings({ workerEnabled: false }))
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })

  it("returns undefined when embedding apiKey is missing", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({ embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, apiKey: "" } })
    )
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })

  it("builds qdrant deps", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({ storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } } })
    )
    const deps = await tryBuildTwinDeps()
    expect(deps).toBeDefined()
    expect(deps?.vectorBackend).toBe("qdrant")
    expect(createVectorStore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "qdrant",
        configId: "twin-runtime-qdrant",
        qdrantUrl: "http://q",
      })
    )
  })

  it("threads default-chain Bedrock settings into the vector runtime", async () => {
    const bedrock = { authMode: "default-chain" as const, region: "us-west-2", profile: "dev" }
    getTwinRuntimeSettings.mockResolvedValue(
      settings({
        storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } },
        embedding: {
          provider: "amazon-bedrock",
          model: "amazon.titan-embed-text-v2:0",
          apiKey: "",
          bedrock,
        },
      })
    )

    const deps = await tryBuildTwinDeps()

    expect(deps?.embedding.bedrock).toEqual(bedrock)
    expect(createVectorStore).toHaveBeenCalledWith(
      expect.objectContaining({
        embeddingConfig: expect.objectContaining({ bedrock }),
        embeddingApiKey: "",
      })
    )
  })

  it("omits reranker by default (disabled) so RAG does not over-fetch (T2.6)", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({ storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } } })
    )
    const deps = await tryBuildTwinDeps()
    expect(deps?.reranker).toBeUndefined()
  })

  it("attaches the lexical reranker scorer when enabled (T2.6)", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({
        storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } },
        reranker: { enabled: true, model: "lexical" },
      })
    )
    const deps = await tryBuildTwinDeps()
    expect(deps?.reranker?.model).toBe("lexical")
    expect(deps?.reranker?.overFetch).toBe(3)
    expect(typeof deps?.reranker?.scorer).toBe("function")
  })

  it("attaches an LLM batch reranker for a non-lexical model when the LLM is configured", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({
        storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } },
        reranker: { enabled: true, model: "llm" },
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-1" },
      })
    )
    const deps = await tryBuildTwinDeps()
    expect(deps?.reranker?.model).toBe("llm")
    expect(deps?.reranker?.overFetch).toBe(5)
    expect(deps?.reranker?.timeoutMs).toBe(8000)
    expect(typeof deps?.reranker?.batchScorer).toBe("function")
    expect(deps?.reranker?.scorer).toBeUndefined()
    expect(createLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-1" })
    )
  })

  it("accepts a baseURL-only (local) LLM endpoint for the model reranker", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({
        storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } },
        reranker: { enabled: true, model: "llm" },
        llm: { provider: "openai", model: "local", apiKey: "", baseURL: "http://localhost:1234" },
      })
    )
    const deps = await tryBuildTwinDeps()
    expect(typeof deps?.reranker?.batchScorer).toBe("function")
  })

  it("degrades a non-lexical model to the lexical scorer when the LLM is unconfigured", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({
        storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } },
        reranker: { enabled: true, model: "llm" },
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "" },
      })
    )
    const deps = await tryBuildTwinDeps()
    // No key / baseURL → fall back to the local lexical scorer, not a dead pass.
    expect(deps?.reranker?.model).toBe("lexical")
    expect(typeof deps?.reranker?.scorer).toBe("function")
    expect(deps?.reranker?.batchScorer).toBeUndefined()
    expect(createLlmClient).not.toHaveBeenCalled()
  })

  it("omits the expansion dep by default (queryExpansion disabled)", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({ storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } } })
    )
    expect((await tryBuildTwinDeps())?.expansion).toBeUndefined()
  })

  it("attaches the LLM expansion dep when enabled and the LLM is configured", async () => {
    createTwinLanguageModel.mockResolvedValue({ __model: true })
    getTwinRuntimeSettings.mockResolvedValue(
      settings({
        storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } },
        queryExpansion: { enabled: true, strategy: "stepback" },
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-1" },
      })
    )
    const deps = await tryBuildTwinDeps()
    expect(deps?.expansion?.strategy).toBe("stepback")
    expect(createTwinLanguageModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", apiKey: "sk-1" })
    )
  })

  it("omits expansion when enabled but the LLM is unconfigured", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({
        storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } },
        queryExpansion: { enabled: true, strategy: "hyde" },
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "" },
      })
    )
    const deps = await tryBuildTwinDeps()
    expect(deps?.expansion).toBeUndefined()
    expect(createTwinLanguageModel).not.toHaveBeenCalled()
  })

  it("builds pinecone deps", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({
        storage: { vectorBackend: "pinecone", pinecone: { apiKey: "p", indexName: "idx" } },
      })
    )
    expect((await tryBuildTwinDeps())?.vectorBackend).toBe("pinecone")
  })

  it("builds weaviate deps", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({ storage: { vectorBackend: "weaviate", weaviate: { url: "http://w" } } })
    )
    expect((await tryBuildTwinDeps())?.vectorBackend).toBe("weaviate")
  })

  it("builds milvus deps", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({ storage: { vectorBackend: "milvus", milvus: { address: "localhost:19530" } } })
    )
    expect((await tryBuildTwinDeps())?.vectorBackend).toBe("milvus")
  })

  it("builds chroma deps in server mode (serverUrl path)", async () => {
    getTwinRuntimeSettings.mockResolvedValue(
      settings({
        storage: {
          vectorBackend: "chroma",
          chroma: { mode: "server", serverUrl: "http://chroma:8000" },
        },
      })
    )
    const deps = await tryBuildTwinDeps()
    expect(deps?.vectorBackend).toBe("chroma")
    expect(createVectorStore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "chroma",
        chromaServerUrl: "http://chroma:8000",
        chromaMode: "server",
      })
    )
  })

  it("builds native deps without further config", async () => {
    getTwinRuntimeSettings.mockResolvedValue(settings({ storage: { vectorBackend: "native" } }))
    expect((await tryBuildTwinDeps())?.vectorBackend).toBe("native")
  })

  it.each([
    [
      "pinecone",
      { vectorBackend: "pinecone", pinecone: { apiKey: "p", indexName: "idx" } },
      "twin-runtime-pinecone",
    ],
    [
      "weaviate",
      { vectorBackend: "weaviate", weaviate: { url: "http://w" } },
      "twin-runtime-weaviate",
    ],
    [
      "milvus",
      { vectorBackend: "milvus", milvus: { address: "localhost:19530" } },
      "twin-runtime-milvus",
    ],
    [
      "chroma",
      { vectorBackend: "chroma", chroma: { mode: "server", serverUrl: "http://c" } },
      "twin-runtime-chroma",
    ],
  ] as const)("derives the Rust registry config id for %s", (_provider, storage, configId) => {
    expect(deriveTwinVectorStoreConfig(settings({ storage }))).toMatchObject({ configId })
  })

  it("rejects the removed Chroma embedded mode instead of building a dead adapter", () => {
    expect(
      deriveTwinVectorStoreConfig(
        settings({ storage: { vectorBackend: "chroma", chroma: { mode: "embedded" } } })
      )
    ).toBeNull()
  })

  it("requires the endpoint configured by local embedding providers", () => {
    const localEmbedding = settings({
      embedding: {
        ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding,
        provider: "ollama",
        apiKey: "",
        baseURL: "",
      },
      storage: { vectorBackend: "native" },
    })

    expect(deriveTwinVectorStoreConfig(localEmbedding)).toBeNull()
    expect(
      deriveTwinVectorStoreConfig(localEmbedding, { requireEmbeddingCredentials: false })
    ).toMatchObject({ provider: "native" })
  })

  it("requires a non-empty embedding model for an enabled runtime", () => {
    expect(
      deriveTwinVectorStoreConfig(
        settings({
          embedding: {
            ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding,
            model: "",
          },
          storage: { vectorBackend: "native" },
        })
      )
    ).toBeNull()
  })

  it("returns undefined when qdrant url is missing", async () => {
    getTwinRuntimeSettings.mockResolvedValue(settings({ storage: { vectorBackend: "qdrant" } }))
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })

  it("returns undefined on any thrown error", async () => {
    getTwinRuntimeSettings.mockRejectedValue(new Error("boom"))
    expect(await tryBuildTwinDeps()).toBeUndefined()
  })
})

describe("buildTwinRuntimeAdapters", () => {
  beforeEach(() => jest.clearAllMocks())

  it("reports disabled unless a cleanup caller explicitly overrides that gate", async () => {
    const disabled = settings({
      workerEnabled: false,
      storage: { vectorBackend: "qdrant", qdrant: { url: "http://q" } },
    })

    await expect(buildTwinRuntimeAdapters(disabled)).resolves.toEqual({
      ready: false,
      reason: "disabled",
    })
    await expect(
      buildTwinRuntimeAdapters(disabled, { requireEnabled: false })
    ).resolves.toMatchObject({ ready: true, adapters: { vectorBackend: "qdrant" } })
  })

  it("returns explicit readiness reasons for credentials, storage, and adapter failures", async () => {
    await expect(
      buildTwinRuntimeAdapters(
        settings({
          embedding: { ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding, apiKey: "" },
        })
      )
    ).resolves.toMatchObject({ ready: false, reason: "missing-embedding-credentials" })

    await expect(
      buildTwinRuntimeAdapters(
        settings({
          embedding: {
            ...DEFAULT_TWIN_RUNTIME_SETTINGS.embedding,
            provider: "ollama",
            apiKey: "",
            baseURL: "",
          },
        })
      )
    ).resolves.toMatchObject({ ready: false, reason: "missing-embedding-credentials" })

    await expect(
      buildTwinRuntimeAdapters(settings({ storage: { vectorBackend: "qdrant" } }))
    ).resolves.toMatchObject({ ready: false, reason: "incomplete-storage" })

    createVectorStore.mockImplementationOnce(() => {
      throw new Error("native unavailable")
    })
    await expect(
      buildTwinRuntimeAdapters(settings({ storage: { vectorBackend: "native" } }))
    ).resolves.toMatchObject({
      ready: false,
      reason: "adapter-unavailable",
      error: "native unavailable",
    })
  })
})
