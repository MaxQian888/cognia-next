const proxyFetchMock = jest.fn()
jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) => proxyFetchMock(...args),
}))

import {
  deriveAdapterFromNpm,
  computeModelVariants,
  expandModelModes,
  fetchModelsDevApi,
  mapModelsDevModel,
  normalizeModelsDevApi,
  type ModelsDevApi,
  type ModelsDevModel,
  type ModelsDevProvider,
} from "./models-dev"

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
  it("emits reasoning tiers for reasoning models", () => {
    expect(computeModelVariants(sonnet)).toEqual(["low", "medium", "high"])
  })
  it("emits nothing for non-reasoning models", () => {
    expect(computeModelVariants({ ...sonnet, reasoning: false })).toEqual([])
    expect(computeModelVariants({ id: "x" })).toEqual([])
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
      variants: ["low", "medium", "high"],
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
  beforeEach(() => proxyFetchMock.mockReset())

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

  it("keys the catalog by our internal provider ids (mapping differences resolved)", () => {
    const norm = normalizeModelsDevApi(api)
    expect(Object.keys(norm).sort()).toEqual(["anthropic", "fireworks"])
    expect(norm.fireworks.modelsDevId).toBe("fireworks-ai")
    expect(norm.anthropic.models[0].id).toBe("claude-sonnet-4-5")
  })

  it("drops providers with no config path in the app", () => {
    const norm = normalizeModelsDevApi(api)
    expect(norm["some-untracked-provider"]).toBeUndefined()
  })
})
