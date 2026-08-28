import { formatSearchResultsForLLM, formatSearchResultsCompact } from "./search-service"
import type { SearchProviderSettings, SearchResponse } from "./types"

const routeSearchMock = jest.fn()

jest.mock("./search-type-router", () => ({
  routeSearch: (...args: unknown[]) => routeSearchMock(...args),
}))

const tavilyTest = jest.fn()
const perplexityTest = jest.fn()
const exaTest = jest.fn()
const searchapiTest = jest.fn()
const serperTest = jest.fn()
const serpapiTest = jest.fn()
const bingTest = jest.fn()
const googleTest = jest.fn()
const googleAITest = jest.fn()
const braveTest = jest.fn()

jest.mock("./providers/tavily", () => ({
  testTavilyConnection: (...a: unknown[]) => tavilyTest(...a),
  searchWithTavily: jest.fn(),
}))
jest.mock("./providers/perplexity", () => ({
  testPerplexityConnection: (...a: unknown[]) => perplexityTest(...a),
  searchWithPerplexity: jest.fn(),
}))
jest.mock("./providers/exa", () => ({
  testExaConnection: (...a: unknown[]) => exaTest(...a),
  searchWithExa: jest.fn(),
  findSimilarWithExa: jest.fn(),
  getContentsWithExa: jest.fn(),
}))
jest.mock("./providers/searchapi", () => ({
  testSearchAPIConnection: (...a: unknown[]) => searchapiTest(...a),
}))
jest.mock("./providers/serper", () => ({
  testSerperConnection: (...a: unknown[]) => serperTest(...a),
}))
jest.mock("./providers/serpapi", () => ({
  testSerpAPIConnection: (...a: unknown[]) => serpapiTest(...a),
}))
jest.mock("./providers/bing", () => ({
  testBingConnection: (...a: unknown[]) => bingTest(...a),
}))
jest.mock("./providers/google", () => ({
  testGoogleConnection: (...a: unknown[]) => googleTest(...a),
}))
jest.mock("./providers/google-ai", () => ({
  testGoogleAIConnection: (...a: unknown[]) => googleAITest(...a),
}))
jest.mock("./providers/brave", () => ({
  testBraveConnection: (...a: unknown[]) => braveTest(...a),
}))

// Usage stats flow through the host-injected reporter seam (ADR-0068 E2);
// the app-side store wiring is covered by lib/search/search-service.test.ts.
const incrementSearchUsageMock = jest.fn()

import {
  search,
  searchWithProvider,
  setSearchUsageReporter,
  testProviderConnection,
  aggregateSearch,
} from "./search-service"
import { getProviderHealth, resetProviderHealth } from "./provider-health"
import { resetRotationState } from "./key-rotation"

beforeAll(() => {
  setSearchUsageReporter((...args) => incrementSearchUsageMock(...args))
})

afterAll(() => {
  setSearchUsageReporter(null)
})

function makeSettings(
  providerId: SearchProviderSettings["providerId"],
  overrides: Partial<SearchProviderSettings> = {}
): SearchProviderSettings {
  return {
    providerId,
    apiKey: "k-1234567890",
    enabled: true,
    priority: 1,
    ...overrides,
  }
}

beforeEach(() => {
  routeSearchMock.mockReset()
  incrementSearchUsageMock.mockClear()
  resetProviderHealth()
  resetRotationState()
  jest.spyOn(console, "warn").mockImplementation(() => {})
})

describe("search()", () => {
  it("throws when providerSettings missing", async () => {
    await expect(search("q")).rejects.toThrow(/Provider settings/)
  })

  it("throws when no providers enabled", async () => {
    await expect(search("q", { providerSettings: {} })).rejects.toThrow(/No search providers/)
  })

  it("throws when chosen provider is missing or unconfigured", async () => {
    const settings = {
      tavily: makeSettings("tavily", { enabled: false }),
      perplexity: makeSettings("perplexity"),
    }
    await expect(search("q", { provider: "tavily", providerSettings: settings })).rejects.toThrow(
      /not enabled/
    )
  })

  it("searches with the given provider and records success usage", async () => {
    const resp: SearchResponse = {
      provider: "tavily",
      query: "q",
      results: [],
      responseTime: 1,
    }
    routeSearchMock.mockResolvedValueOnce(resp)
    const settings = { tavily: makeSettings("tavily") }
    const r = await search("q", {
      provider: "tavily",
      providerSettings: settings,
    })
    expect(r).toBe(resp)
    await Promise.resolve()
    expect(incrementSearchUsageMock).toHaveBeenCalledWith("tavily", expect.any(Number), true)
  })

  it("falls back to next provider on failure", async () => {
    const settings = {
      tavily: makeSettings("tavily", { priority: 1 }),
      perplexity: makeSettings("perplexity", { priority: 2 }),
    }
    routeSearchMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
      provider: "perplexity",
      query: "q",
      results: [],
      responseTime: 1,
    })
    const r = await search("q", { providerSettings: settings })
    expect(r.provider).toBe("perplexity")
    await Promise.resolve()
    expect(incrementSearchUsageMock).toHaveBeenCalledWith("tavily", expect.any(Number), false)
    expect(incrementSearchUsageMock).toHaveBeenCalledWith("perplexity", expect.any(Number), true)
  })

  it("tries preferred providers first in the requested order, then global priority", async () => {
    const settings = {
      tavily: makeSettings("tavily", { priority: 1 }),
      perplexity: makeSettings("perplexity", { priority: 2 }),
      exa: makeSettings("exa", { priority: 3 }),
    }
    routeSearchMock
      .mockRejectedValueOnce(new Error("preferred failed"))
      .mockRejectedValueOnce(new Error("second preferred failed"))
      .mockResolvedValueOnce({
        provider: "tavily",
        query: "q",
        results: [],
        responseTime: 1,
      })

    const result = await search("q", {
      providerSettings: settings,
      preferredProviders: ["exa", "perplexity", "exa"],
      maxRetries: 0,
    })

    expect(result.provider).toBe("tavily")
    expect(routeSearchMock.mock.calls.map((call) => call[1])).toEqual([
      "exa",
      "perplexity",
      "tavily",
    ])
  })

  it("post-filters includeDomains and falls back when a provider has no compliant results", async () => {
    const settings = {
      tavily: makeSettings("tavily", { priority: 1 }),
      perplexity: makeSettings("perplexity", { priority: 2 }),
    }
    routeSearchMock
      .mockResolvedValueOnce({
        provider: "tavily",
        query: "q",
        answer: "off-domain answer",
        results: [{ title: "Other", url: "https://other.test/a", content: "x", score: 1 }],
        responseTime: 1,
      })
      .mockResolvedValueOnce({
        provider: "perplexity",
        query: "q",
        results: [
          { title: "Docs", url: "https://docs.example.com/a", content: "x", score: 1 },
          { title: "Other", url: "https://other.test/b", content: "y", score: 0.5 },
        ],
        responseTime: 1,
      })

    const result = await search("q", {
      providerSettings: settings,
      includeDomains: ["example.com"],
      maxRetries: 0,
    })

    expect(routeSearchMock).toHaveBeenCalledTimes(2)
    expect(result.provider).toBe("perplexity")
    expect(result.results.map((item) => item.url)).toEqual(["https://docs.example.com/a"])
    expect(result.totalResults).toBe(1)
  })

  it("returns an empty filtered response when no provider has a compliant domain", async () => {
    const settings = {
      tavily: makeSettings("tavily", { priority: 1 }),
      perplexity: makeSettings("perplexity", { priority: 2 }),
    }
    routeSearchMock
      .mockResolvedValueOnce({
        provider: "tavily",
        query: "q",
        answer: "must not escape the domain constraint",
        results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
        responseTime: 1,
      })
      .mockResolvedValueOnce({
        provider: "perplexity",
        query: "q",
        results: [{ title: "B", url: "not a valid URL", content: "b", score: 1 }],
        responseTime: 1,
      })

    const result = await search("q", {
      providerSettings: settings,
      includeDomains: ["allowed.test"],
      maxRetries: 0,
    })

    expect(result.results).toEqual([])
    expect(result.answer).toBeUndefined()
    expect(result.totalResults).toBe(0)
  })

  it("does not fall back when fallback disabled", async () => {
    const settings = {
      tavily: makeSettings("tavily"),
      perplexity: makeSettings("perplexity"),
    }
    routeSearchMock.mockRejectedValueOnce(new Error("boom"))
    await expect(
      search("q", {
        provider: "tavily",
        fallbackEnabled: false,
        providerSettings: settings,
      })
    ).rejects.toThrow(/boom/)
    expect(routeSearchMock).toHaveBeenCalledTimes(1)
  })

  it("skips an open-circuit provider (tries the healthy one first)", async () => {
    // Trip tavily's breaker directly.
    const health = getProviderHealth()
    health.setConfig({ failureThreshold: 1, cooldownMs: 60_000 })
    health.recordResult("tavily", false)

    const settings = {
      tavily: makeSettings("tavily", { priority: 1 }),
      perplexity: makeSettings("perplexity", { priority: 2 }),
    }
    routeSearchMock.mockResolvedValueOnce({
      provider: "perplexity",
      query: "q",
      results: [],
      responseTime: 1,
    })
    const r = await search("q", { providerSettings: settings })
    // perplexity is tried first because tavily's circuit is open.
    expect(r.provider).toBe("perplexity")
    expect(routeSearchMock).toHaveBeenCalledTimes(1)
    expect(routeSearchMock.mock.calls[0][1]).toBe("perplexity")
  })
})

describe("search() retry + key rotation", () => {
  const ok = (provider: SearchProviderSettings["providerId"]): SearchResponse => ({
    provider,
    query: "q",
    results: [],
    responseTime: 1,
  })

  it("retries the same provider on a transient error, then succeeds", async () => {
    routeSearchMock
      .mockRejectedValueOnce(new Error("Tavily API error: 429 - rate limited"))
      .mockResolvedValueOnce(ok("tavily"))
    const r = await search("q", {
      provider: "tavily",
      providerSettings: { tavily: makeSettings("tavily") },
      fallbackEnabled: false,
      retryBackoffMs: 0,
    })
    expect(r.provider).toBe("tavily")
    expect(routeSearchMock).toHaveBeenCalledTimes(2)
  })

  it("rotates to the next key across retries when the pool has multiple keys", async () => {
    const settings = {
      tavily: makeSettings("tavily", {
        apiKey: "key-A",
        apiKeys: ["key-B"],
        apiKeyRotationEnabled: true,
        apiKeyRotationStrategy: "round-robin",
      }),
    }
    routeSearchMock
      .mockRejectedValueOnce(new Error("API error: 429 - x"))
      .mockResolvedValueOnce(ok("tavily"))
    await search("q", {
      provider: "tavily",
      providerSettings: settings,
      fallbackEnabled: false,
      retryBackoffMs: 0,
    })
    const key1 = (routeSearchMock.mock.calls[0][2] as SearchProviderSettings).apiKey
    const key2 = (routeSearchMock.mock.calls[1][2] as SearchProviderSettings).apiKey
    expect(key1).toBe("key-A")
    expect(key2).toBe("key-B")
  })

  it("does not retry when maxRetries is 0", async () => {
    routeSearchMock.mockRejectedValueOnce(new Error("API error: 429 - x"))
    await expect(
      search("q", {
        provider: "tavily",
        providerSettings: { tavily: makeSettings("tavily") },
        fallbackEnabled: false,
        maxRetries: 0,
      })
    ).rejects.toThrow(/429/)
    expect(routeSearchMock).toHaveBeenCalledTimes(1)
  })

  it("does not retry a permanent (4xx) error — falls straight through to the next provider", async () => {
    const settings = {
      tavily: makeSettings("tavily", { priority: 1 }),
      perplexity: makeSettings("perplexity", { priority: 2 }),
    }
    routeSearchMock
      .mockRejectedValueOnce(new Error("API error: 400 - bad query"))
      .mockResolvedValueOnce(ok("perplexity"))
    const r = await search("q", { providerSettings: settings, retryBackoffMs: 0 })
    expect(r.provider).toBe("perplexity")
    // tavily attempted once (no retry) + perplexity once
    expect(routeSearchMock).toHaveBeenCalledTimes(2)
  })

  it("exhausts retries then falls back to the next provider", async () => {
    const settings = {
      tavily: makeSettings("tavily", { priority: 1 }),
      perplexity: makeSettings("perplexity", { priority: 2 }),
    }
    routeSearchMock
      .mockRejectedValueOnce(new Error("API error: 500 - x"))
      .mockRejectedValueOnce(new Error("API error: 500 - x"))
      .mockRejectedValueOnce(new Error("API error: 500 - x"))
      .mockResolvedValueOnce(ok("perplexity"))
    const r = await search("q", { providerSettings: settings, retryBackoffMs: 0 })
    expect(r.provider).toBe("perplexity")
    // tavily: 1 + 2 retries = 3 attempts (default maxRetries=2), then perplexity
    expect(routeSearchMock).toHaveBeenCalledTimes(4)
  })
})

describe("searchWithProvider", () => {
  it("delegates to routeSearch with synthesized settings", async () => {
    routeSearchMock.mockResolvedValueOnce({
      provider: "tavily",
      query: "q",
      results: [],
      responseTime: 1,
    })
    const r = await searchWithProvider("tavily", "q", "key-1234567890")
    expect(r.provider).toBe("tavily")
    expect(routeSearchMock).toHaveBeenCalled()
  })
})

describe("testProviderConnection", () => {
  it("dispatches to the correct provider test", async () => {
    tavilyTest.mockResolvedValueOnce(true)
    expect(await testProviderConnection("tavily", "k")).toBe(true)
    perplexityTest.mockResolvedValueOnce(true)
    expect(await testProviderConnection("perplexity", "k")).toBe(true)
    exaTest.mockResolvedValueOnce(true)
    expect(await testProviderConnection("exa", "k")).toBe(true)
    searchapiTest.mockResolvedValueOnce(true)
    expect(await testProviderConnection("searchapi", "k")).toBe(true)
    serperTest.mockResolvedValueOnce(true)
    expect(await testProviderConnection("serper", "k")).toBe(true)
    serpapiTest.mockResolvedValueOnce(true)
    expect(await testProviderConnection("serpapi", "k")).toBe(true)
    bingTest.mockResolvedValueOnce(true)
    expect(await testProviderConnection("bing", "k")).toBe(true)
    googleAITest.mockResolvedValueOnce(true)
    expect(await testProviderConnection("google-ai", "k")).toBe(true)
    braveTest.mockResolvedValueOnce(true)
    expect(await testProviderConnection("brave", "k")).toBe(true)
  })

  it("requires cx for google", async () => {
    expect(await testProviderConnection("google", "k")).toBe(false)
    expect(await testProviderConnection("google", "k", { cx: "" })).toBe(false)
    googleTest.mockResolvedValueOnce(true)
    expect(await testProviderConnection("google", "k", { cx: "abc" })).toBe(true)
  })

  it("returns false on thrown errors", async () => {
    tavilyTest.mockRejectedValueOnce(new Error("network"))
    expect(await testProviderConnection("tavily", "k")).toBe(false)
  })

  it("returns false for unknown provider", async () => {
    expect(await testProviderConnection("nope" as SearchProviderSettings["providerId"], "k")).toBe(
      false
    )
  })
})

describe("aggregateSearch", () => {
  it("throws when no providers enabled", async () => {
    await expect(
      aggregateSearch(
        "q",
        {} as Record<SearchProviderSettings["providerId"], SearchProviderSettings>
      )
    ).rejects.toThrow(/No search providers/)
  })

  it("merges results from multiple providers and dedupes URLs", async () => {
    routeSearchMock.mockImplementation(async (_q, providerId) => ({
      provider: providerId,
      query: "q",
      answer: providerId === "perplexity" ? "answer-text" : undefined,
      results: [
        {
          title: providerId,
          url: "https://example.com/a?utm_source=x",
          content: providerId === "tavily" ? "long content here" : "short",
          score: providerId === "tavily" ? 0.5 : 0.9,
        },
      ],
      responseTime: 1,
    }))
    const settings = {
      tavily: makeSettings("tavily", { priority: 1 }),
      perplexity: makeSettings("perplexity", { priority: 2 }),
    } as Record<SearchProviderSettings["providerId"], SearchProviderSettings>
    const r = await aggregateSearch("q", settings)
    expect(r.results).toHaveLength(1)
    expect(r.results[0].score).toBe(0.9)
    expect(r.answer).toBe("answer-text")
  })

  it("normalizes each provider's scores to [0,1] before ranking", async () => {
    // Two providers on different score scales, each with a spread of results.
    routeSearchMock.mockImplementation(async (_q, providerId) => {
      if (providerId === "tavily") {
        return {
          provider: "tavily",
          query: "q",
          results: [
            { title: "t-top", url: "https://t.test/1", content: "c", score: 0.9 },
            { title: "t-bot", url: "https://t.test/2", content: "c", score: 0.5 },
          ],
          responseTime: 1,
        }
      }
      return {
        provider: "exa",
        query: "q",
        results: [
          { title: "e-top", url: "https://e.test/1", content: "c", score: 100 },
          { title: "e-bot", url: "https://e.test/2", content: "c", score: 20 },
        ],
        responseTime: 1,
      }
    })
    const settings = {
      tavily: makeSettings("tavily", { priority: 1 }),
      exa: makeSettings("exa", { priority: 2 }),
    } as Record<SearchProviderSettings["providerId"], SearchProviderSettings>
    const r = await aggregateSearch("q", settings)
    // After min-max per provider, both top results become 1 and both bottoms 0
    // — exa's raw 100 no longer dominates tavily's 0.9.
    const byUrl = Object.fromEntries(r.results.map((x) => [x.url, x.score]))
    expect(byUrl["https://t.test/1"]).toBe(1)
    expect(byUrl["https://e.test/1"]).toBe(1)
    expect(byUrl["https://t.test/2"]).toBe(0)
    expect(byUrl["https://e.test/2"]).toBe(0)
  })

  it("throws when all providers fail", async () => {
    routeSearchMock.mockRejectedValue(new Error("network"))
    const settings = {
      tavily: makeSettings("tavily"),
    } as Record<SearchProviderSettings["providerId"], SearchProviderSettings>
    await expect(aggregateSearch("q", settings)).rejects.toThrow(/All search providers/)
  })

  it("handles malformed URLs in results", async () => {
    routeSearchMock.mockResolvedValueOnce({
      provider: "tavily",
      query: "q",
      results: [
        {
          title: "x",
          url: "not a url",
          content: "c",
          score: 0.5,
        },
      ],
      responseTime: 1,
    })
    const settings = {
      tavily: makeSettings("tavily"),
    } as Record<SearchProviderSettings["providerId"], SearchProviderSettings>
    const r = await aggregateSearch("q", settings)
    expect(r.results).toHaveLength(1)
  })

  it("includes images aggregate when provided", async () => {
    routeSearchMock.mockResolvedValueOnce({
      provider: "tavily",
      query: "q",
      results: [],
      images: [{ url: "https://example.com/img.png" }],
      responseTime: 1,
    })
    const settings = {
      tavily: makeSettings("tavily"),
    } as Record<SearchProviderSettings["providerId"], SearchProviderSettings>
    const r = await aggregateSearch("q", settings)
    expect(r.images).toHaveLength(1)
  })
})

describe("formatSearchResultsForLLM", () => {
  it("includes provider, answer, and each result", () => {
    const text = formatSearchResultsForLLM({
      provider: "tavily",
      query: "react",
      answer: "summary",
      results: [
        {
          title: "First",
          url: "https://example.com",
          content: "Body 1",
          score: 1,
          publishedDate: "2024-01-01",
        },
      ],
      responseTime: 12,
    })
    expect(text).toContain("react")
    expect(text).toContain("tavily")
    expect(text).toContain("summary")
    expect(text).toContain("First")
    expect(text).toContain("Published: 2024-01-01")
  })

  it("works with no answer/results", () => {
    const text = formatSearchResultsForLLM({
      provider: "tavily",
      query: "q",
      results: [],
      responseTime: 1,
    })
    expect(text).toContain("Web Search Results")
  })
})

describe("formatSearchResultsCompact", () => {
  it("renders [Answer] and indexed list", () => {
    const text = formatSearchResultsCompact({
      provider: "tavily",
      query: "q",
      answer: "summary",
      results: [
        { title: "T1", url: "https://a.com", content: "x".repeat(300), score: 1 },
        { title: "T2", url: "https://b.com", content: "y", score: 1 },
      ],
      responseTime: 1,
    })
    expect(text).toContain("[Answer] summary")
    expect(text).toContain("[1] T1")
    expect(text).toContain("[2] T2")
  })

  it("limits to 5 results", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      title: `T${i}`,
      url: `https://x${i}.com`,
      content: "c",
      score: 1,
    }))
    const text = formatSearchResultsCompact({
      provider: "tavily",
      query: "q",
      results,
      responseTime: 1,
    })
    expect(text).toContain("[5] T4")
    expect(text).not.toContain("[6]")
  })
})
