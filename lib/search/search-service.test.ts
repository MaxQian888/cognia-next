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

const incrementSearchUsageMock = jest.fn()

jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({ incrementSearchUsage: incrementSearchUsageMock }),
  },
}))

import {
  search,
  searchWithProvider,
  testProviderConnection,
  aggregateSearch,
} from "./search-service"

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
