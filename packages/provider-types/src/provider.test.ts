import {
  BUILTIN_API_PROTOCOLS,
  PROVIDERS,
  getAllProviders,
  getModelConfig,
  getProviderConfig,
  catalogEntryToProviderConfig,
  isChatCapableCatalogEntry,
} from "./provider"
import type { BuiltInProviderCatalogEntry } from "./built-in-provider-catalog"

describe("provider catalog fallback", () => {
  it("returns built-in provider and model configs", () => {
    expect(getProviderConfig("openai")).toBe(PROVIDERS.openai)
    expect(getProviderConfig("missing")).toBeUndefined()
    expect(getModelConfig("openai", "gpt-4.1")).toMatchObject({
      id: "gpt-4.1",
      supportsTools: true,
    })
    expect(getModelConfig("openai", "missing")).toBeUndefined()
  })

  it("exposes built-in API protocols and merges dynamic providers", () => {
    expect(BUILTIN_API_PROTOCOLS).toEqual(["openai", "anthropic", "gemini"])
    expect(getAllProviders().openai).toBe(PROVIDERS.openai)
  })
})

describe("catalog → PROVIDERS merge", () => {
  it("folds in chat-capable catalog providers absent from the inline map, with their default base URL", () => {
    // These live only in the built-in catalog (not in the curated inline map)
    // and must now surface in the settings provider list.
    expect(PROVIDERS.moonshot).toBeDefined()
    expect(PROVIDERS.moonshot?.defaultBaseURL).toBe("https://api.moonshot.cn/v1")
    expect(PROVIDERS.perplexity?.defaultBaseURL).toBe("https://api.perplexity.ai")
    expect(PROVIDERS.siliconflow?.defaultBaseURL).toBe("https://api.siliconflow.cn/v1")
    // Enterprise provider without a fixed endpoint is still listed.
    expect(PROVIDERS.azure).toBeDefined()
    expect(PROVIDERS.azure?.category).toBe("enterprise")
  })

  it("excludes embedding / reranker / media providers (no chat-completion surface)", () => {
    expect(PROVIDERS.voyage).toBeUndefined()
    expect(PROVIDERS.jina).toBeUndefined()
    expect(PROVIDERS.fal).toBeUndefined()
  })

  it("keeps the curated inline entry on id collision", () => {
    // openai exists in both the inline map and the catalog — the inline,
    // richer definition must win (identity preserved for downstream `===`).
    expect(getProviderConfig("openai")).toBe(PROVIDERS.openai)
    expect(PROVIDERS.openai?.models.length).toBeGreaterThan(0)
  })
})

describe("catalogEntryToProviderConfig", () => {
  const baseEntry: BuiltInProviderCatalogEntry = {
    id: "demo",
    name: "Demo",
    type: "cloud",
    protocol: "openai",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "demo-1",
    defaultEnabled: false,
    defaultBaseURL: "https://demo.example/v1",
    category: "specialized",
    description: "A demo provider",
    models: [
      {
        id: "demo-1",
        name: "Demo One",
        contextLength: 8000,
        supportsTools: true,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsStreaming: true,
      },
    ],
  }

  it("projects the catalog category onto the ProviderConfig union", () => {
    expect(catalogEntryToProviderConfig(baseEntry).category).toBe("specialized")
    expect(catalogEntryToProviderConfig({ ...baseEntry, category: "flagship" }).category).toBe(
      "flagship"
    )
    expect(catalogEntryToProviderConfig({ ...baseEntry, category: "enterprise" }).category).toBe(
      "enterprise"
    )
  })

  it("carries over endpoint, protocol and model metadata", () => {
    const cfg = catalogEntryToProviderConfig(baseEntry)
    expect(cfg.defaultBaseURL).toBe("https://demo.example/v1")
    expect(cfg.protocol).toBe("openai")
    expect(cfg.models).toEqual([
      expect.objectContaining({ id: "demo-1", name: "Demo One", contextLength: 8000 }),
    ])
  })

  it("tolerates an entry with no models or category", () => {
    const cfg = catalogEntryToProviderConfig({
      ...baseEntry,
      category: undefined,
      models: undefined,
    })
    expect(cfg.models).toEqual([])
    expect(cfg.category).toBeUndefined()
  })
})

describe("isChatCapableCatalogEntry", () => {
  const entry: BuiltInProviderCatalogEntry = {
    id: "x",
    name: "X",
    type: "cloud",
    protocol: "openai",
    apiKeyRequired: true,
    baseURLRequired: false,
    defaultModel: "x-1",
    defaultEnabled: false,
  }

  it("flags providers explicitly marked as non-chat", () => {
    expect(isChatCapableCatalogEntry(entry)).toBe(true)
    expect(
      isChatCapableCatalogEntry({
        ...entry,
        description: "Embeddings only. Not a chat completion API.",
      })
    ).toBe(false)
  })
})
