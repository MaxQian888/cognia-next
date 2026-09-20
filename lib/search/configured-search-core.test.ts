// The precedence tests run the real `search()` against a mocked router so the
// option merge is observable without a provider HTTP call.
const routeSearchMock = jest.fn()
jest.mock("@cognia/web-search/search-type-router", () => ({
  ...jest.requireActual("@cognia/web-search/search-type-router"),
  routeSearch: (...args: unknown[]) => routeSearchMock(...args),
}))

import type { AppSettings } from "@cognia/agent-config-types"
import type { SearchResponse } from "@cognia/web-search/types"

const searchMock = jest.fn()
const cacheGetMock = jest.fn()
const cacheSetMock = jest.fn()
const cacheSetConfigMock = jest.fn()
const piiGateMock = jest.fn()

jest.mock("@cognia/web-search/search-service", () => ({
  // Keep the real module's helpers (stripUndefined feeds the cache key); only
  // `search` itself is stubbed so no provider call leaves the process.
  ...jest.requireActual("@cognia/web-search/search-service"),
  search: (...args: unknown[]) => searchMock(...args),
}))

jest.mock("@cognia/web-search/search-cache", () => ({
  getSearchCache: () => ({
    get: cacheGetMock,
    set: cacheSetMock,
    setConfig: cacheSetConfigMock,
  }),
}))

jest.mock("@cognia/redact", () => {
  const actual = jest.requireActual("@cognia/redact")
  return {
    ...actual,
    hasNoLeakingPii: (...args: unknown[]) => piiGateMock(...args),
  }
})

import { searchWithSettings } from "./configured-search-core"
import { getProviderHealth, resetProviderHealth } from "@cognia/web-search/provider-health"

const response: SearchResponse = {
  provider: "tavily",
  query: "query",
  results: [],
  responseTime: 1,
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    searchProviders: {
      tavily: { providerId: "tavily", apiKey: "key", enabled: true, priority: 1 },
    } as AppSettings["searchProviders"],
    defaultSearchProvider: "tavily",
    searchFallbackEnabled: true,
    searchMaxRetries: 3,
    searchMaxResults: 7,
    defaultSearchType: "news",
    searchSafeSearchEnabled: true,
    searchSafeSearchLevel: "strict",
    searchCacheEnabled: true,
    searchCacheTTL: 12_000,
    searchCacheMaxEntries: 42,
    ...overrides,
  } as AppSettings
}

beforeEach(() => {
  searchMock.mockReset().mockResolvedValue(response)
  cacheGetMock.mockReset().mockReturnValue(null)
  cacheSetMock.mockReset()
  cacheSetConfigMock.mockReset()
  piiGateMock.mockReset().mockReturnValue(true)
})

describe("searchWithSettings", () => {
  it("applies configured defaults and redacts PII before the provider call", async () => {
    await searchWithSettings("please find alice@example.com", { settings: settings() })

    const [query, options] = searchMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(query).toContain("<EMAIL_001>")
    expect(query).not.toContain("alice@example.com")
    expect(options).toMatchObject({
      provider: "tavily",
      fallbackEnabled: true,
      maxRetries: 3,
      // Stored defaults now ride `baseOptions` (the lowest precedence rung),
      // not the flat call-time fields.
      baseOptions: {
        maxResults: 7,
        searchType: "news",
        safeSearch: "strict",
      },
    })
  })

  it("fails closed when sensitive data remains after redaction", async () => {
    piiGateMock.mockReturnValue(false)

    await expect(searchWithSettings("sensitive", { settings: settings() })).rejects.toThrow(
      "Search blocked"
    )
    expect(searchMock).not.toHaveBeenCalled()
  })

  it("configures and reuses the shared search cache", async () => {
    cacheGetMock.mockReturnValue(response)

    await expect(searchWithSettings("cached", { settings: settings() })).resolves.toBe(response)

    expect(cacheSetConfigMock).toHaveBeenCalledWith({ defaultTTL: 12_000, maxSize: 42 })
    expect(searchMock).not.toHaveBeenCalled()
    expect(cacheSetMock).not.toHaveBeenCalled()
  })

  it("applies the current verification policy to a raw cache hit", async () => {
    cacheGetMock.mockReturnValue({
      ...response,
      results: [
        { title: "Blocked", url: "https://blocked.example/page", content: "nope", score: 0.9 },
        { title: "Allowed", url: "https://allowed.example/page", content: "ok", score: 0.8 },
      ],
    })

    const result = await searchWithSettings("cached-policy", {
      settings: settings({
        sourceVerificationSettings: {
          enabled: true,
          mode: "ask",
          minimumCredibilityScore: 0,
          autoFilterLowCredibility: false,
          showVerificationBadges: true,
          trustedDomains: [],
          blockedDomains: ["blocked.example"],
          enableCrossValidation: false,
        },
      }),
    })

    expect(result.results.map((item) => item.title)).toEqual(["Allowed"])
    expect(searchMock).not.toHaveBeenCalled()
  })

  it("lets explicit request options override stored defaults", async () => {
    await searchWithSettings("override", {
      settings: settings(),
      options: { maxResults: 2, searchType: "academic", safeSearch: "off" },
    })

    expect(searchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxResults: 2, searchType: "academic", safeSearch: "off" })
    )
  })

  it("caches raw results and applies source verification to the returned response", async () => {
    searchMock.mockResolvedValue({
      ...response,
      results: [
        { title: "Blocked", url: "https://blocked.example/page", content: "nope", score: 0.9 },
        { title: "Allowed", url: "https://allowed.example/page", content: "ok", score: 0.8 },
      ],
    })

    const result = await searchWithSettings("policy", {
      settings: settings({
        sourceVerificationSettings: {
          enabled: true,
          mode: "ask",
          minimumCredibilityScore: 0,
          autoFilterLowCredibility: false,
          showVerificationBadges: true,
          trustedDomains: [],
          blockedDomains: ["blocked.example"],
          enableCrossValidation: false,
        },
      }),
    })

    expect(result.results.map((item) => item.title)).toEqual(["Allowed"])
    expect(cacheSetMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        results: [
          expect.objectContaining({ title: "Blocked" }),
          expect.objectContaining({ title: "Allowed" }),
        ],
      }),
      "tavily",
      expect.any(Object)
    )
  })

  it("prioritizes any selected provider and keeps selected domains hard", async () => {
    await searchWithSettings("research", {
      settings: settings({
        defaultSearchSources: ["exa", "tavily", "wikipedia", "custom-docs"],
        customSearchSources: [
          { id: "custom-docs", name: "Docs", domain: "https://docs.example.com/path" },
        ],
        defaultIncludeDomains: ["ignored.example"],
      }),
    })

    expect(searchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        provider: undefined,
        preferredProviders: ["exa", "tavily"],
        baseOptions: expect.objectContaining({
          includeDomains: ["wikipedia.org", "docs.example.com"],
        }),
      })
    )
    // The selected domains moved into baseOptions — they are no longer a
    // call-time field, so a provider's own defaultOptions can still beat them.
  })
})

describe("searchWithSettings — provider defaultOptions + breaker config", () => {
  beforeEach(() => {
    resetProviderHealth()
    routeSearchMock.mockReset().mockResolvedValue(response)
  })

  it("pushes the normalized persisted breaker config into the shared breaker", async () => {
    const setConfigSpy = jest.spyOn(getProviderHealth(), "setConfig")
    await searchWithSettings("q", {
      settings: settings({
        searchProviderHealth: { enabled: true, failureThreshold: 99, cooldownMs: 1 },
      }),
    })
    // Clamped to SEARCH_PROVIDER_HEALTH_LIMITS on the way in.
    expect(setConfigSpy).toHaveBeenCalledWith({
      enabled: true,
      failureThreshold: 10,
      cooldownMs: 5000,
    })
    setConfigSpy.mockRestore()
  })

  it("applies the library defaults when settings carry no health block", async () => {
    const setConfigSpy = jest.spyOn(getProviderHealth(), "setConfig")
    await searchWithSettings("q", { settings: settings() })
    expect(setConfigSpy).toHaveBeenCalledWith({
      enabled: true,
      failureThreshold: 3,
      cooldownMs: 30_000,
    })
    setConfigSpy.mockRestore()
  })

  it("lets a provider's defaultOptions beat the global default and lose to a call-time override", async () => {
    const core = jest.requireActual("@cognia/web-search/search-service") as {
      search: (query: string, options: unknown) => Promise<unknown>
    }
    searchMock.mockImplementation(core.search)

    const withProviderDefaults = settings({
      defaultSearchType: "general",
      searchCacheEnabled: false,
      searchProviders: {
        tavily: {
          providerId: "tavily",
          apiKey: "key",
          enabled: true,
          priority: 1,
          defaultOptions: { searchType: "news" },
        },
      } as AppSettings["searchProviders"],
    })

    await searchWithSettings("q", { settings: withProviderDefaults })
    // routeSearch(query, provider, settings, options) — options is arg 3.
    expect(routeSearchMock.mock.calls[0][3]).toMatchObject({ searchType: "news" })

    routeSearchMock.mockClear()
    await searchWithSettings("q", {
      settings: withProviderDefaults,
      options: { searchType: "images" },
    })
    expect(routeSearchMock.mock.calls[0][3]).toMatchObject({ searchType: "images" })
  })
})
