jest.mock("@/lib/router-fusion/gate/load-engine", () => ({
  loadRouterFusionHost: jest.fn(),
}))
const googleAIFetchMock = jest.fn()
jest.mock("@cognia/web-search/proxy-search-fetch", () => ({
  ...jest.requireActual("@cognia/web-search/proxy-search-fetch"),
  googleAIFetch: (...args: unknown[]) => googleAIFetchMock(...args),
}))

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
import { __resetBreakerForTesting } from "@/lib/router-fusion/gate/breaker"
import { loadRouterFusionHost } from "@/lib/router-fusion/gate/load-engine"
import type { RouterFusionHost } from "@/lib/router-fusion/gate/load-engine"
import type { BeginLedgeredUtilityCallInput } from "@/lib/router-fusion/gate/utility-ledger"

const loadHostMock = loadRouterFusionHost as jest.Mock

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

  it("folds provider defaultOptions into the cache key so edits bust stale entries", async () => {
    const withDefaults = settings({
      searchProviders: {
        tavily: {
          providerId: "tavily",
          apiKey: "key",
          enabled: true,
          priority: 1,
          defaultOptions: { searchType: "news", searchDepth: "deep" },
        },
      } as AppSettings["searchProviders"],
    })

    await searchWithSettings("keyed", { settings: withDefaults })

    // Pinned provider: its defaults are the effective middle rung, so they
    // appear in the flat key fields AND in the digest — editing them must
    // change the key on both read and write.
    const getKeyOptions = cacheGetMock.mock.calls[0][2] as Record<string, unknown>
    expect(getKeyOptions).toMatchObject({
      searchType: "news",
      searchDepth: "deep",
      providerDefaults: { tavily: { searchType: "news", searchDepth: "deep" } },
    })
    expect(cacheSetMock.mock.calls[0][3]).toEqual(getKeyOptions)
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

// --- Router + Fusion ledger (ADR-0188 D27) -----------------------------------
// One search provider is itself a generation: Google AI answers from Gemini.
// With `utilityLedger` on, the seam goes down with the options and that call is
// reserved and settled; off, the options are what they always were.

describe("searchWithSettings — the generating search provider's ledger seam", () => {
  const reserved: BeginLedgeredUtilityCallInput[] = []
  const withLedger = (): AppSettings =>
    settings({
      searchProviders: {
        "google-ai": { providerId: "google-ai", apiKey: "gemini-key", enabled: true, priority: 1 },
      } as AppSettings["searchProviders"],
      defaultSearchProvider: "google-ai",
      searchCacheEnabled: false,
      routerFusion: { enabled: true, surfaces: { utilityLedger: true } },
    } as Partial<AppSettings>)

  beforeEach(() => {
    __resetBreakerForTesting()
    reserved.length = 0
    googleAIFetchMock.mockReset()
    loadHostMock.mockReset().mockResolvedValue({
      beginLedgeredUtilityCall: async (input: BeginLedgeredUtilityCallInput) => {
        reserved.push(input)
        return {
          kind: "granted",
          handle: {
            runId: "run-1",
            maxOutputTokens: 700,
            succeeded: async () => {},
            failed: async () => {},
            unknown: async () => {},
          },
        }
      },
    } as unknown as RouterFusionHost)
  })

  it("[ACC:OFF-02] adds no seam option at all while the switch is off", async () => {
    await searchWithSettings("query", { settings: settings() })
    const options = searchMock.mock.calls[0][1] as Record<string, unknown>
    expect(options).not.toHaveProperty("generate")
    expect(loadHostMock).not.toHaveBeenCalled()
  })

  it("passes the seam with the options when the switch is on", async () => {
    await searchWithSettings("query", { settings: withLedger() })
    const options = searchMock.mock.calls[0][1] as Record<string, unknown>
    expect(typeof options.generate).toBe("function")
  })

  it("a caller's own options can never displace the seam", async () => {
    const callerSeam = jest.fn()
    await searchWithSettings("query", {
      settings: withLedger(),
      options: { generate: callerSeam } as never,
    })
    const options = searchMock.mock.calls[0][1] as Record<string, unknown>
    expect(options.generate).not.toBe(callerSeam)
  })

  it("reserves the Gemini search on the ledger, through the real search service", async () => {
    // The shipped `search()` and google-ai provider run for this one case; only
    // the HTTP round trip is faked. `routeSearch` is stubbed module-wide for
    // the precedence describe — restore the real router here.
    const core = jest.requireActual("@cognia/web-search/search-service") as {
      search: (query: string, options: unknown) => Promise<unknown>
    }
    const router = jest.requireActual("@cognia/web-search/search-type-router") as {
      routeSearch: (...args: unknown[]) => Promise<unknown>
    }
    searchMock.mockImplementation(core.search)
    routeSearchMock.mockImplementation(router.routeSearch)
    googleAIFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "",
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: "grounded answer" }], role: "model" },
            groundingMetadata: {
              groundingChunks: [{ web: { uri: "https://example.com", title: "Example" } }],
              groundingSupports: [],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25, totalTokenCount: 125 },
      }),
    })

    const response = await searchWithSettings("what shipped today", { settings: withLedger() })

    expect(response.answer).toBe("grounded answer")
    expect(reserved).toEqual([
      expect.objectContaining({
        featureId: "web-search:web-search.google-ai",
        providerId: "google",
        modelId: "gemini-2.0-flash",
        workspaceId: null,
      }),
    ])
    const body = JSON.parse(
      (googleAIFetchMock.mock.calls[0][1] as { body: string }).body
    ) as Record<string, unknown>
    expect(body).toMatchObject({ generationConfig: { maxOutputTokens: 700 } })
  })
})
