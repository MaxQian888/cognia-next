const proxyFetchMock = jest.fn()

import {
  deriveAdapterFromNpm,
  buildCatalogSnapshotFromModelsDev,
  computeModelVariants,
  expandModelModes,
  fetchModelsDevApi,
  mapModelsDevModel,
  normalizeModelsDevApi,
  type ModelsDevApi,
  type ModelsDevModel,
  type ModelsDevProvider,
} from "./models-dev"
import {
  resetProviderCoreRuntimeAdaptersForTesting,
  setProviderCoreRuntimeAdapters,
} from "./runtime-adapters"

const anthropicProvider: ModelsDevProvider = {
  id: "anthropic",
  name: "Anthropic",
  doc: "https://docs.anthropic.com",
  npm: "@ai-sdk/anthropic",
  models: {},
}

const sonnet: ModelsDevModel = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5 (latest)",
  family: "claude-sonnet",
  attachment: true,
  reasoning: true,
  tool_call: true,
  temperature: true,
  knowledge: "2025-07-31",
  release_date: "2025-09-29",
  last_updated: "2025-09-29",
  modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  open_weights: false,
  limit: { context: 200000, output: 64000 },
  cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
}

describe("deriveAdapterFromNpm", () => {
  it("maps known driver packages", () => {
    expect(deriveAdapterFromNpm("@ai-sdk/anthropic")).toBe("anthropic")
    expect(deriveAdapterFromNpm("@ai-sdk/google")).toBe("gemini")
    expect(deriveAdapterFromNpm("@ai-sdk/google-vertex")).toBe("gemini")
    expect(deriveAdapterFromNpm("@openrouter/ai-sdk-provider")).toBe("openrouter")
  })

  it("defaults to openai-compatible (long-tail fallback)", () => {
    expect(deriveAdapterFromNpm("@ai-sdk/openai-compatible")).toBe("openai-compatible")
    expect(deriveAdapterFromNpm("@ai-sdk/some-unknown")).toBe("openai-compatible")
    expect(deriveAdapterFromNpm(undefined)).toBe("openai-compatible")
  })
})

describe("computeModelVariants", () => {
  it("emits nothing for non-reasoning models", () => {
    expect(computeModelVariants({ ...sonnet, reasoning: false })).toEqual([])
    expect(computeModelVariants({ id: "x" })).toEqual([])
  })

  it("falls back to the conservative three when the provider is unknown", () => {
    expect(computeModelVariants(sonnet)).toEqual(["low", "medium", "high"])
  })

  it("resolves the real ladder from the provider's wire surface", () => {
    // Anthropic's effort-GA families reach low…max…
    expect(computeModelVariants({ id: "claude-opus-4-6", reasoning: true }, "anthropic")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    // …OpenAI-native has `minimal` and rejects `max`…
    expect(computeModelVariants({ id: "gpt-5", reasoning: true }, "openai")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ])
    // …and a gateway keeps only the three it can distinguish.
    expect(computeModelVariants({ id: "deepseek-reasoner", reasoning: true }, "deepseek")).toEqual([
      "low",
      "medium",
      "high",
    ])
  })

  it("emits no tiers for a reasoning model whose provider rejects the effort param", () => {
    // models.dev marks Sonnet 4.5 `reasoning: true` — it DOES think — but it
    // 400s on `output_config.effort`. Badging it with tiers it cannot honour is
    // exactly what the flat placeholder used to do.
    expect(computeModelVariants(sonnet, "anthropic")).toEqual([])
  })
})

describe("expandModelModes", () => {
  it("expands experimental.modes with camelCased provider body", () => {
    const model: ModelsDevModel = {
      id: "claude-opus-4.7",
      experimental: {
        modes: {
          fast: {
            cost: { input: 30, output: 150, cache_read: 3, cache_write: 37.5 },
            provider: {
              body: { speed: "fast", reasoning_effort: "high" },
              headers: { "anthropic-beta": "fast-mode-2026-02-01" },
            },
          },
        },
      },
    }
    const modes = expandModelModes(model)
    expect(modes).toHaveLength(1)
    expect(modes[0]).toMatchObject({
      id: "claude-opus-4.7-fast",
      mode: "fast",
      body: { speed: "fast", reasoningEffort: "high" },
      headers: { "anthropic-beta": "fast-mode-2026-02-01" },
    })
    expect(modes[0].pricing).toMatchObject({ promptPer1M: 30, completionPer1M: 150 })
  })

  it("returns empty when no experimental modes", () => {
    expect(expandModelModes({ id: "x" })).toEqual([])
  })
})

describe("mapModelsDevModel", () => {
  it("maps the full model shape including pricing, modalities, metadata", () => {
    const mapped = mapModelsDevModel(anthropicProvider, sonnet)
    expect(mapped).toMatchObject({
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5 (latest)",
      contextLength: 200000,
      maxOutputTokens: 64000,
      supportsTools: true,
      supportsVision: true,
      supportsAudio: false,
      supportsVideo: false,
      supportsStreaming: true,
      supportsReasoning: true,
      family: "claude-sonnet",
      releaseDate: "2025-09-29",
      knowledge: "2025-07-31",
      adapter: "anthropic",
      // Sonnet 4.5 reasons but rejects `output_config.effort`, so it carries no
      // effort tiers — see the `computeModelVariants` cases above.
      variants: undefined,
      supportsAttachment: true,
      supportsTemperature: true,
      openWeights: false,
    })
    expect(mapped.pricing).toEqual({
      promptPer1M: 3,
      completionPer1M: 15,
      cachedInputPer1M: 0.3,
      cacheCreationPer1M: 3.75,
    })
  })

  it("handles models missing limit/cost/modalities", () => {
    const bare: ModelsDevModel = { id: "bare-model" }
    const mapped = mapModelsDevModel({ models: {} }, bare)
    expect(mapped.contextLength).toBeUndefined()
    expect(mapped.maxOutputTokens).toBeUndefined()
    expect(mapped.pricing).toBeUndefined()
    expect(mapped.supportsTools).toBe(false)
    expect(mapped.supportsVision).toBe(false)
    expect(mapped.adapter).toBe("openai-compatible")
    expect(mapped.name).toBe("bare-model")
  })

  it("flags interleaved-thinking support and leaves the extras undefined when absent", () => {
    const interleaved = mapModelsDevModel(
      { models: {} },
      { id: "claude-opus", interleaved: { field: "thinking" } }
    )
    expect(interleaved.supportsInterleaved).toBe(true)

    const bare = mapModelsDevModel({ models: {} }, { id: "plain" })
    expect(bare.supportsInterleaved).toBeUndefined()
    expect(bare.supportsAttachment).toBeUndefined()
    expect(bare.openWeights).toBeUndefined()
    expect(bare.supportsTemperature).toBeUndefined()
  })

  it("prefers the per-model provider override for adapter + apiUrl", () => {
    const model: ModelsDevModel = {
      id: "glm-4.7",
      provider: { npm: "@ai-sdk/openai-compatible", api: "https://example/v1" },
    }
    const mapped = mapModelsDevModel({ npm: "@ai-sdk/google", models: {} }, model)
    expect(mapped.adapter).toBe("openai-compatible")
    expect(mapped.apiUrl).toBe("https://example/v1")
  })

  it("detects embedding models", () => {
    const mapped = mapModelsDevModel({ models: {} }, { id: "text-embedding-3-large" })
    expect(mapped.supportsEmbedding).toBe(true)
  })

  it("maps the structured_output flag", () => {
    expect(
      mapModelsDevModel({ models: {} }, { id: "x", structured_output: true })
        .supportsStructuredOutput
    ).toBe(true)
    // Absent → undefined (not surfaced as a capability)
    expect(mapModelsDevModel({ models: {} }, { id: "y" }).supportsStructuredOutput).toBeUndefined()
  })

  it("maps audio/video input and image/embedding output modalities", () => {
    const mapped = mapModelsDevModel(
      { models: {} },
      {
        id: "omni",
        modalities: { input: ["text", "audio", "video"], output: ["image", "embedding"] },
      }
    )
    expect(mapped.supportsAudio).toBe(true)
    expect(mapped.supportsVideo).toBe(true)
    expect(mapped.supportsImageGeneration).toBe(true)
    expect(mapped.supportsEmbedding).toBe(true)
  })

  it("treats an all-undefined cost object as no pricing", () => {
    const mapped = mapModelsDevModel({ models: {} }, { id: "x", cost: {} })
    expect(mapped.pricing).toBeUndefined()
  })

  it("treats a cache-only cost (no input/output) as no pricing, not $0", () => {
    // Without per-token rates the cost views must show "unknown", not "$0.00".
    const mapped = mapModelsDevModel(
      { models: {} },
      { id: "x", cost: { cache_read: 0.3, cache_write: 3.75 } }
    )
    expect(mapped.pricing).toBeUndefined()
  })

  it("keeps pricing when only one of input/output is present", () => {
    const mapped = mapModelsDevModel({ models: {} }, { id: "x", cost: { input: 2 } })
    expect(mapped.pricing).toMatchObject({ promptPer1M: 2, completionPer1M: 0 })
  })
})

describe("fetchModelsDevApi", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset()
    setProviderCoreRuntimeAdapters({ proxyFetch: proxyFetchMock })
  })

  afterEach(() => {
    resetProviderCoreRuntimeAdaptersForTesting()
  })

  it("returns the parsed provider map on success", async () => {
    proxyFetchMock.mockResolvedValue({ ok: true, json: async () => ({ openai: { models: {} } }) })
    await expect(fetchModelsDevApi()).resolves.toEqual({ openai: { models: {} } })
  })

  it("throws on a non-ok response", async () => {
    proxyFetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" })
    await expect(fetchModelsDevApi()).rejects.toThrow(/500/)
  })

  it("throws when the payload is not a provider map", async () => {
    proxyFetchMock.mockResolvedValue({ ok: true, json: async () => [1, 2, 3] })
    await expect(fetchModelsDevApi()).rejects.toThrow(/not a provider map/)
  })
})

describe("normalizeModelsDevApi", () => {
  const api: ModelsDevApi = {
    anthropic: { ...anthropicProvider, models: { "claude-sonnet-4-5": sonnet } },
    "fireworks-ai": {
      name: "Fireworks",
      npm: "@ai-sdk/openai-compatible",
      models: { "model-a": { id: "model-a", tool_call: true, limit: { context: 1000 } } },
    },
    "some-untracked-provider": {
      name: "Untracked",
      models: { x: { id: "x" } },
    },
  }

  it("keys known providers by internal ids and namespaces the dynamic long tail", () => {
    const norm = normalizeModelsDevApi(api)
    expect(Object.keys(norm).sort()).toEqual([
      "anthropic",
      "fireworks",
      "models-dev:some-untracked-provider",
    ])
    expect(norm.fireworks.modelsDevId).toBe("fireworks-ai")
    expect(norm.anthropic.models[0].id).toBe("claude-sonnet-4-5")
  })

  it("keeps providers without a built-in config path as namespaced experimental entries", () => {
    const norm = normalizeModelsDevApi(api)
    expect(norm["models-dev:some-untracked-provider"]).toMatchObject({
      modelsDevId: "some-untracked-provider",
      name: "Untracked",
    })
  })
})

describe("buildCatalogSnapshotFromModelsDev", () => {
  it("applies manual provider wiring over models.dev and keeps long-tail providers experimental", () => {
    const snapshot = buildCatalogSnapshotFromModelsDev(
      {
        anthropic: {
          ...anthropicProvider,
          models: { "claude-sonnet-4-5": sonnet },
        },
        tail: {
          name: "Tail Provider",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "tail/image-1": {
              id: "tail/image-1",
              status: "beta",
              modalities: { input: ["text"], output: ["image"] },
            },
          },
        },
      },
      {
        revisionId: "2026-07-31-test",
        generatedAt: "2026-07-31T00:00:00.000Z",
        checksum: "sha256:test",
        certifiedProviderIds: new Set(["anthropic"]),
        builtInCatalog: [
          {
            id: "anthropic",
            name: "Anthropic",
            type: "cloud",
            protocol: "anthropic",
            adapter: "anthropic",
            apiKeyRequired: true,
            baseURLRequired: false,
            defaultModel: "claude-sonnet-4-5",
            defaultEnabled: true,
            models: [],
          },
        ],
      }
    )

    expect(snapshot.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "anthropic", tier: "certified" }),
        expect.objectContaining({ id: "models-dev:tail", tier: "experimental" }),
      ])
    )
    expect(snapshot.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "anthropic:claude-sonnet-4-5",
          lifecycle: "active",
        }),
        expect.objectContaining({
          id: "tail:image-1",
          lifecycle: "preview",
          capabilities: expect.objectContaining({ imageGeneration: true }),
        }),
      ])
    )
    expect(snapshot.offerings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerRef: "anthropic",
          upstreamId: "claude-sonnet-4-5",
          endpointType: "messages",
        }),
        expect.objectContaining({
          providerRef: "models-dev:tail",
          upstreamId: "tail/image-1",
          endpointType: "images",
        }),
      ])
    )
  })

  it("keeps every built-in default resolvable through an active fallback offering", () => {
    const snapshot = buildCatalogSnapshotFromModelsDev(
      {},
      {
        revisionId: "fallback",
        generatedAt: "2026-07-31T00:00:00.000Z",
        checksum: "sha256:fallback",
        certifiedProviderIds: new Set(),
        builtInCatalog: [
          {
            id: "local-test",
            name: "Local Test",
            type: "local",
            protocol: "openai",
            adapter: "local-openai-compatible",
            apiKeyRequired: false,
            baseURLRequired: true,
            defaultModel: "local-model",
            defaultEnabled: false,
            models: [],
          },
        ],
      }
    )

    expect(snapshot.offerings).toContainEqual(
      expect.objectContaining({
        id: "local-test:local-model",
        upstreamId: "local-model",
        lifecycle: "active",
      })
    )
  })
})
