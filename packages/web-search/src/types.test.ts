import {
  SEARCH_PROVIDERS,
  DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS,
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  DEFAULT_SOURCE_VERIFICATION_SETTINGS,
  SEARCH_PROVIDER_HEALTH_LIMITS,
  isProviderConfigured,
  getEnabledProviders,
  getProviderConfigIssues,
  getProviderState,
  isProviderRetired,
  validateSearchEndpoint,
  normalizeSearchProviderHealthSettings,
  validateApiKey,
  createDefaultSearchUsageEntry,
  createDefaultSearchUsageStats,
  type SearchProviderType,
  type SearchProviderSettings,
  type CustomSearchSource,
  type LegacyCustomSearchSource,
} from "./types"

describe("SEARCH_PROVIDERS", () => {
  it("contains all 13 providers", () => {
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
        "deepseek",
        "tinyfish",
        "searxng",
      ])
    )
    expect(Object.keys(SEARCH_PROVIDERS)).toHaveLength(13)
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

describe("provider descriptors", () => {
  it("separates lifecycle, integration kind and auth", () => {
    expect(SEARCH_PROVIDERS.bing.lifecycle).toEqual({ status: "retired", retiredOn: "2025-08-11" })
    expect(SEARCH_PROVIDERS.google.lifecycle).toEqual({ status: "legacy", endDate: "2027-01-01" })
    expect(SEARCH_PROVIDERS["google-ai"].integration).toBe("grounding")
    expect(SEARCH_PROVIDERS.searxng).toMatchObject({ integration: "self-hosted", auth: "endpoint" })
    expect(SEARCH_PROVIDERS.google.auth).toBe("api-key+cx")
    expect(isProviderRetired("bing")).toBe(true)
    expect(isProviderRetired("brave")).toBe(false)
  })

  it("offers a vendor reader only where an integrated adapter exists", () => {
    const readers = (Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]).filter(
      (id) => SEARCH_PROVIDERS[id].operations.read
    )
    expect(readers.sort()).toEqual(["deepseek", "exa", "tavily", "tinyfish"])
  })

  it("keeps every new provider disabled by default", () => {
    for (const id of ["deepseek", "tinyfish", "searxng"] as const) {
      expect(DEFAULT_SEARCH_PROVIDER_SETTINGS[id].enabled).toBe(false)
    }
  })
})

describe("descriptor-driven configuration", () => {
  it("needs no key for an endpoint-only provider", () => {
    expect(getProviderConfigIssues("searxng", { baseUrl: "https://search.example" })).toEqual([])
    expect(getProviderConfigIssues("searxng", {})).toEqual(["missing-endpoint"])
  })

  it("requires an explicit grant for a private or plain-HTTP endpoint", () => {
    expect(getProviderConfigIssues("searxng", { baseUrl: "http://127.0.0.1:8888" })).toEqual([
      "endpoint-not-granted",
    ])
    expect(
      getProviderConfigIssues("searxng", {
        baseUrl: "http://127.0.0.1:8888",
        allowPrivateEndpoint: true,
      })
    ).toEqual([])
    expect(getProviderConfigIssues("searxng", { baseUrl: "http://search.example" })).toEqual([
      "invalid-endpoint",
    ])
  })

  it("never treats a retired provider as configured", () => {
    expect(isProviderConfigured("bing", { apiKey: "k" })).toBe(false)
    expect(getProviderState("bing", { apiKey: "k", enabled: true })).toBe("retired")
  })

  it("rejects a stored engine the provider does not list", () => {
    expect(getProviderConfigIssues("searchapi", { apiKey: "k", engine: "altavista" })).toEqual([
      "unsupported-engine",
    ])
    expect(getProviderConfigIssues("searchapi", { apiKey: "k", engine: "baidu" })).toEqual([])
  })

  it("reports distinct display states", () => {
    expect(getProviderState("tavily", { apiKey: "k", enabled: false })).toBe("disabled")
    expect(getProviderState("tavily", { apiKey: "", enabled: true })).toBe("missing-key")
    expect(getProviderState("google", { apiKey: "k", enabled: true })).toBe("missing-config")
    expect(getProviderState("tavily", { apiKey: "k", enabled: true })).toBe("configured")
  })
})

describe("validateSearchEndpoint", () => {
  it("normalizes a deployment path prefix and strips a trailing /search", () => {
    expect(validateSearchEndpoint("https://example.com/searx/search/")).toEqual({
      ok: true,
      baseUrl: "https://example.com/searx",
      isPrivate: false,
    })
  })

  it("rejects credentials, query, fragment and non-http schemes", () => {
    expect(validateSearchEndpoint("https://u:p@example.com").issue).toBe("embedded-credentials")
    expect(validateSearchEndpoint("https://example.com/?q=1").issue).toBe("query-or-fragment")
    expect(validateSearchEndpoint("https://example.com/#x").issue).toBe("query-or-fragment")
    expect(validateSearchEndpoint("ftp://example.com").issue).toBe("unsupported-scheme")
    expect(validateSearchEndpoint("not a url").issue).toBe("invalid-url")
    expect(validateSearchEndpoint("").issue).toBe("missing")
  })

  it("accepts plain HTTP only for private hosts", () => {
    expect(validateSearchEndpoint("http://192.168.1.5:8080")).toMatchObject({
      ok: true,
      isPrivate: true,
    })
    expect(validateSearchEndpoint("http://[::1]:8080")).toMatchObject({ ok: true, isPrivate: true })
    expect(validateSearchEndpoint("http://example.com").issue).toBe("insecure-public-endpoint")
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

describe("research source types", () => {
  it("keeps a separate legacy read shape while new custom sources require a domain", () => {
    const source: CustomSearchSource = { id: "docs", name: "Docs", domain: "docs.example.com" }
    const legacy: LegacyCustomSearchSource = { id: "old", name: "old.example.com" }
    expect(source.domain).toBe("docs.example.com")
    expect(legacy.domain).toBeUndefined()
  })
})

describe("normalizeSearchProviderHealthSettings", () => {
  it("returns the defaults for absent/empty input", () => {
    expect(normalizeSearchProviderHealthSettings()).toEqual(DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS)
    expect(normalizeSearchProviderHealthSettings(null)).toEqual(
      DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS
    )
    expect(normalizeSearchProviderHealthSettings({})).toEqual(
      DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS
    )
  })

  it("fills missing fields from defaults and keeps valid ones", () => {
    expect(normalizeSearchProviderHealthSettings({ enabled: false })).toEqual({
      enabled: false,
      failureThreshold: DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS.failureThreshold,
      cooldownMs: DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS.cooldownMs,
    })
    expect(
      normalizeSearchProviderHealthSettings({ failureThreshold: 5, cooldownMs: 60_000 })
    ).toEqual({ enabled: true, failureThreshold: 5, cooldownMs: 60_000 })
  })

  it("clamps out-of-range values to the published limits", () => {
    expect(normalizeSearchProviderHealthSettings({ failureThreshold: 0, cooldownMs: 1 })).toEqual({
      enabled: true,
      failureThreshold: SEARCH_PROVIDER_HEALTH_LIMITS.failureThreshold.min,
      cooldownMs: SEARCH_PROVIDER_HEALTH_LIMITS.cooldownMs.min,
    })
    expect(
      normalizeSearchProviderHealthSettings({
        failureThreshold: 99,
        cooldownMs: Number.MAX_SAFE_INTEGER,
      })
    ).toEqual({
      enabled: true,
      failureThreshold: SEARCH_PROVIDER_HEALTH_LIMITS.failureThreshold.max,
      cooldownMs: SEARCH_PROVIDER_HEALTH_LIMITS.cooldownMs.max,
    })
  })

  it("rounds fractional values", () => {
    expect(
      normalizeSearchProviderHealthSettings({ failureThreshold: 2.6, cooldownMs: 30_000.4 })
    ).toEqual({ enabled: true, failureThreshold: 3, cooldownMs: 30_000 })
  })

  it("coerces non-finite and wrong-typed values back to the default", () => {
    expect(
      normalizeSearchProviderHealthSettings({
        failureThreshold: Number.NaN,
        cooldownMs: Number.POSITIVE_INFINITY,
      })
    ).toEqual(DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS)
    expect(
      normalizeSearchProviderHealthSettings({
        failureThreshold: "3" as unknown as number,
        cooldownMs: undefined,
      })
    ).toEqual(DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS)
  })
})
