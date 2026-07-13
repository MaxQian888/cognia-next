import {
  SEARCH_PROVIDERS,
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  DEFAULT_SOURCE_VERIFICATION_SETTINGS,
  isProviderConfigured,
  getEnabledProviders,
  validateApiKey,
  createDefaultSearchUsageEntry,
  createDefaultSearchUsageStats,
  type SearchProviderType,
  type SearchProviderSettings,
} from "./types"

describe("SEARCH_PROVIDERS", () => {
  it("contains all 10 providers", () => {
    expect(Object.keys(SEARCH_PROVIDERS)).toEqual(
      expect.arrayContaining([
        "tavily",
        "perplexity",
        "exa",
        "searchapi",
        "serper",
        "serpapi",
        "bing",
        "google",
        "google-ai",
        "brave",
      ])
    )
    expect(Object.keys(SEARCH_PROVIDERS)).toHaveLength(10)
  })

  it("each provider has the required config fields", () => {
    for (const cfg of Object.values(SEARCH_PROVIDERS)) {
      expect(typeof cfg.id).toBe("string")
      expect(typeof cfg.name).toBe("string")
      expect(typeof cfg.description).toBe("string")
      expect(typeof cfg.apiKeyRequired).toBe("boolean")
      expect(typeof cfg.docsUrl).toBe("string")
      expect(cfg.features).toEqual(
        expect.objectContaining({
          aiAnswer: expect.any(Boolean),
          newsSearch: expect.any(Boolean),
          academicSearch: expect.any(Boolean),
          imageSearch: expect.any(Boolean),
          videoSearch: expect.any(Boolean),
          domainFilter: expect.any(Boolean),
          recencyFilter: expect.any(Boolean),
          countryFilter: expect.any(Boolean),
          contentExtraction: expect.any(Boolean),
          streaming: expect.any(Boolean),
        })
      )
    }
  })
})

describe("DEFAULT_SEARCH_PROVIDER_SETTINGS", () => {
  it("returns default settings keyed by provider id", () => {
    for (const id of Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]) {
      const entry = DEFAULT_SEARCH_PROVIDER_SETTINGS[id]
      expect(entry.providerId).toBe(id)
      expect(entry.apiKey).toBe("")
      expect(typeof entry.enabled).toBe("boolean")
      expect(typeof entry.priority).toBe("number")
    }
  })
})

describe("DEFAULT_SOURCE_VERIFICATION_SETTINGS", () => {
  it("uses 'ask' mode by default", () => {
    expect(DEFAULT_SOURCE_VERIFICATION_SETTINGS.mode).toBe("ask")
    expect(DEFAULT_SOURCE_VERIFICATION_SETTINGS.enabled).toBe(true)
    expect(DEFAULT_SOURCE_VERIFICATION_SETTINGS.minimumCredibilityScore).toBe(0.3)
  })
})

describe("isProviderConfigured", () => {
  it("returns false when settings are missing", () => {
    expect(isProviderConfigured("tavily")).toBe(false)
  })

  it("returns false when apiKey is empty", () => {
    expect(isProviderConfigured("tavily", { apiKey: "" })).toBe(false)
    expect(isProviderConfigured("tavily", { apiKey: "   " })).toBe(false)
  })

  it("returns true for non-google providers with apiKey", () => {
    expect(isProviderConfigured("tavily", { apiKey: "tvly-abc" })).toBe(true)
  })

  it("requires cx for google", () => {
    expect(isProviderConfigured("google", { apiKey: "key" })).toBe(false)
    expect(isProviderConfigured("google", { apiKey: "key", cx: "" })).toBe(false)
    expect(isProviderConfigured("google", { apiKey: "key", cx: "   " })).toBe(false)
    expect(isProviderConfigured("google", { apiKey: "key", cx: "abc123" })).toBe(true)
  })
})

describe("getEnabledProviders", () => {
  const settings = {
    tavily: {
      providerId: "tavily" as const,
      apiKey: "tvly-abc",
      enabled: true,
      priority: 5,
    },
    perplexity: {
      providerId: "perplexity" as const,
      apiKey: "pplx-xyz",
      enabled: true,
      priority: 1,
    },
    bing: {
      providerId: "bing" as const,
      apiKey: "",
      enabled: true,
      priority: 2,
    },
    google: {
      providerId: "google" as const,
      apiKey: "key",
      enabled: true,
      priority: 3,
    },
    brave: {
      providerId: "brave" as const,
      apiKey: "BSA-key-long",
      enabled: false,
      priority: 4,
    },
  } satisfies Partial<Record<SearchProviderType, SearchProviderSettings>>

  it("filters out disabled providers", () => {
    const enabled = getEnabledProviders(settings)
    const ids = enabled.map((s) => s.providerId)
    expect(ids).not.toContain("brave")
  })

  it("filters out providers without apiKey", () => {
    const enabled = getEnabledProviders(settings)
    expect(enabled.map((s) => s.providerId)).not.toContain("bing")
  })

  it("filters out google without cx", () => {
    const enabled = getEnabledProviders(settings)
    expect(enabled.map((s) => s.providerId)).not.toContain("google")
  })

  it("sorts by priority ascending", () => {
    const enabled = getEnabledProviders(settings)
    expect(enabled.map((s) => s.providerId)).toEqual(["perplexity", "tavily"])
  })

  it("handles undefined entries", () => {
    const result = getEnabledProviders({
      tavily: undefined as unknown as SearchProviderSettings,
    })
    expect(result).toEqual([])
  })
})

describe("validateApiKey", () => {
  it("rejects empty key", () => {
    expect(validateApiKey("tavily", "")).toBe(false)
    expect(validateApiKey("tavily", "   ")).toBe(false)
  })

  it("rejects unknown provider", () => {
    expect(validateApiKey("notreal" as SearchProviderType, "anything")).toBe(false)
  })

  it("validates prefix when provider has one", () => {
    expect(validateApiKey("tavily", "tvly-1234567890abc")).toBe(true)
    expect(validateApiKey("tavily", "tvly-short")).toBe(false)
    expect(validateApiKey("tavily", "wrong-1234567890abc")).toBe(false)
  })

  it("validates min length when no prefix", () => {
    expect(validateApiKey("exa", "1234567890")).toBe(true)
    expect(validateApiKey("exa", "short")).toBe(false)
  })
})

describe("createDefaultSearchUsageEntry", () => {
  it("returns a fresh zeroed usage entry", () => {
    const entry = createDefaultSearchUsageEntry()
    expect(entry).toEqual({
      searchCount: 0,
      lastUsedAt: null,
      totalResponseTime: 0,
      errorCount: 0,
    })
  })

  it("returns a new object each call", () => {
    expect(createDefaultSearchUsageEntry()).not.toBe(createDefaultSearchUsageEntry())
  })
})

describe("createDefaultSearchUsageStats", () => {
  it("contains an entry for every provider", () => {
    const stats = createDefaultSearchUsageStats()
    for (const id of Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]) {
      expect(stats[id]).toEqual(createDefaultSearchUsageEntry())
    }
  })
})
