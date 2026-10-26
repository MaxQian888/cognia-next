import {
  checkProviderEligibility,
  degradedControlsFor,
  getEffectiveSearchCapabilities,
  resolveEngine,
  getProvidersForType,
  providerSupportsType,
  getBestProviderForType,
  routeSearch,
  searchNews,
  searchImages,
  searchVideos,
  searchAcademic,
  findSimilar,
  getContents,
  autoRouteSearch,
} from "./search-type-router"
import type { SearchProviderSettings, SearchProviderType, SearchResponse } from "./types"
import { SEARCH_PROVIDERS } from "./types"
import { searchWithBrave } from "./providers/brave"
import { searchWithSearchAPI } from "./providers/searchapi"
import { searchWithExa } from "./providers/exa"
import { searchWithGoogle } from "./providers/google"

jest.mock("./providers/brave", () => ({
  searchWithBrave: jest.fn(async () => makeResp("brave", "general")),
  searchNewsWithBrave: jest.fn(async () => makeResp("brave", "news")),
  searchImagesWithBrave: jest.fn(async () => makeResp("brave", "images")),
  searchVideosWithBrave: jest.fn(async () => makeResp("brave", "videos")),
}))
jest.mock("./providers/bing", () => ({
  searchWithBing: jest.fn(async () => makeResp("bing", "general")),
  searchNewsWithBing: jest.fn(async () => makeResp("bing", "news")),
  searchImagesWithBing: jest.fn(async () => makeResp("bing", "images")),
}))
jest.mock("./providers/google", () => ({
  searchWithGoogle: jest.fn(async () => makeResp("google", "general")),
  searchImagesWithGoogle: jest.fn(async () => makeResp("google", "images")),
}))
jest.mock("./providers/google-ai", () => ({
  GOOGLE_AI_DEFAULT_MODEL: "gemini-3.8-flash",
  searchWithGoogleAI: jest.fn(async () => makeResp("google-ai", "general")),
}))
jest.mock("./providers/searchapi", () => ({
  searchWithSearchAPI: jest.fn(async () => makeResp("searchapi", "general")),
  searchNewsWithSearchAPI: jest.fn(async () => makeResp("searchapi", "news")),
  searchImagesWithSearchAPI: jest.fn(async () => makeResp("searchapi", "images")),
  searchScholarWithSearchAPI: jest.fn(async () => makeResp("searchapi", "academic")),
}))
jest.mock("./providers/serper", () => ({
  searchWithSerper: jest.fn(async () => makeResp("serper", "general")),
  searchNewsWithSerper: jest.fn(async () => makeResp("serper", "news")),
  searchImagesWithSerper: jest.fn(async () => makeResp("serper", "images")),
  searchVideosWithSerper: jest.fn(async () => makeResp("serper", "videos")),
  searchScholarWithSerper: jest.fn(async () => makeResp("serper", "academic")),
}))
jest.mock("./providers/serpapi", () => ({
  searchWithSerpAPI: jest.fn(async () => makeResp("serpapi", "general")),
  searchNewsWithSerpAPI: jest.fn(async () => makeResp("serpapi", "news")),
  searchImagesWithSerpAPI: jest.fn(async () => makeResp("serpapi", "images")),
}))
jest.mock("./providers/exa", () => ({
  searchWithExa: jest.fn(async () => makeResp("exa", "general")),
  findSimilarWithExa: jest.fn(async () => makeResp("exa", "similar")),
  getContentsWithExa: jest.fn(async () => [
    {
      title: "T",
      url: "https://example.com",
      content: "c",
      score: 0.5,
    },
  ]),
}))
jest.mock("./providers/tavily", () => ({
  searchWithTavily: jest.fn(async () => makeResp("tavily", "general")),
}))
jest.mock("./providers/perplexity", () => ({
  searchWithPerplexity: jest.fn(async () => makeResp("perplexity", "general")),
}))
jest.mock("./providers/deepseek", () => ({
  searchWithDeepSeek: jest.fn(async () => makeResp("deepseek", "general")),
}))
jest.mock("./providers/tinyfish", () => ({
  searchWithTinyFish: jest.fn(async () => makeResp("tinyfish", "general")),
}))
jest.mock("./providers/searxng", () => ({
  SEARXNG_ENGINE_PATTERN: /^[a-z0-9][a-z0-9 _.-]{0,39}$/i,
  searchWithSearXNG: jest.fn(async (_q: string, _s: unknown, _o: unknown, type: string) =>
    makeResp("searxng", type)
  ),
}))

function makeResp(provider: SearchProviderType | string, label: string): SearchResponse {
  return {
    provider: provider as SearchProviderType,
    query: label,
    results: [],
    responseTime: 1,
  }
}

function makeSettings(
  providerId: SearchProviderType,
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

describe("getProvidersForType", () => {
  it("returns all providers for general", () => {
    const result = getProvidersForType("general")
    expect(result.length).toBeGreaterThanOrEqual(10)
  })

  it("returns providers that support news, never retired or general-only ones", () => {
    const result = getProvidersForType("news")
    expect(result).toEqual(
      expect.arrayContaining(["brave", "searchapi", "serper", "serpapi", "tavily", "exa"])
    )
    expect(result).not.toContain("bing")
    expect(result).not.toContain("perplexity")
  })

  it("returns providers that support academic", () => {
    const result = getProvidersForType("academic")
    expect(result).toEqual(expect.arrayContaining(["searchapi", "serper", "exa"]))
  })

  it("returns providers that support videos", () => {
    const result = getProvidersForType("videos")
    expect(result).toEqual(expect.arrayContaining(["brave", "serper"]))
  })
})

describe("providerSupportsType", () => {
  it("everyone supports general", () => {
    expect(providerSupportsType("brave", "general")).toBe(true)
  })

  it("only some support academic", () => {
    expect(providerSupportsType("exa", "academic")).toBe(true)
    expect(providerSupportsType("brave", "academic")).toBe(false)
  })

  it("returns false for unknown provider", () => {
    expect(providerSupportsType("nope" as SearchProviderType, "general")).toBe(false)
  })
})

describe("getBestProviderForType", () => {
  it("returns null when no providers configured", () => {
    expect(getBestProviderForType("news", {})).toBeNull()
  })

  it("returns the highest-priority provider that supports the type", () => {
    const settings = {
      perplexity: makeSettings("perplexity", { priority: 1 }),
      exa: makeSettings("exa", { priority: 2 }),
    }
    expect(getBestProviderForType("news", settings)).toBe("exa")
  })

  it("returns null rather than a provider that would run general search instead", () => {
    const settings = {
      "google-ai": makeSettings("google-ai", { priority: 1 }),
    }
    expect(getBestProviderForType("videos", settings)).toBeNull()
  })
})

describe("routeSearch", () => {
  it("routes general searches", async () => {
    const result = await routeSearch("q", "tavily", makeSettings("tavily"))
    expect(result.provider).toBe("tavily")
  })

  it("routes news to news handler if available", async () => {
    const result = await routeSearch("q", "brave", makeSettings("brave"), {
      searchType: "news",
    })
    expect(result.query).toBe("news")
  })

  it("refuses an explicit type the adapter does not implement, before any request", async () => {
    await expect(
      routeSearch("q", "google", makeSettings("google", { cx: "abc" }), { searchType: "news" })
    ).rejects.toMatchObject({ name: "SearchCapabilityError", reason: "unsupported-type" })
    expect(searchWithGoogle).not.toHaveBeenCalled()
  })

  it("routes images / videos / academic", async () => {
    const img = await routeSearch("q", "brave", makeSettings("brave"), {
      searchType: "images",
    })
    expect(img.query).toBe("images")
    const vid = await routeSearch("q", "serper", makeSettings("serper"), {
      searchType: "videos",
    })
    expect(vid.query).toBe("videos")
    const acad = await routeSearch("q", "exa", makeSettings("exa"), {
      searchType: "academic",
    })
    // Exa academic is the general endpoint with the research-paper category.
    expect(searchWithExa).toHaveBeenLastCalledWith(
      "q",
      expect.any(String),
      expect.objectContaining({ category: "research paper" })
    )
    expect(acad.searchType).toBe("academic")
  })

  it("throws for unknown provider", async () => {
    await expect(
      routeSearch("q", "nope" as SearchProviderType, makeSettings("tavily"))
    ).rejects.toThrow(/Unknown provider/)
  })

  it("merges defaultOptions and call-time options", async () => {
    const settings = makeSettings("tavily", {
      defaultOptions: { searchType: "news" },
    })
    const result = await routeSearch("q", "tavily", settings)
    expect(result.searchType).toBe("news")
  })

  it("does not let explicit undefined call-time fields clobber defaultOptions", async () => {
    const settings = makeSettings("brave", {
      defaultOptions: { searchType: "news" },
    })
    const result = await routeSearch("q", "brave", settings, {
      searchType: undefined,
    })
    expect(result.query).toBe("news")
  })

  it("requires google cx", async () => {
    await expect(routeSearch("q", "google", makeSettings("google", { cx: "" }))).rejects.toThrow(
      /cx.*required/i
    )
  })
})

describe("specialty wrappers", () => {
  it("searchNews routes news", async () => {
    const r = await searchNews("q", "brave", makeSettings("brave"))
    expect(r.query).toBe("news")
  })

  it("searchImages routes images", async () => {
    const r = await searchImages("q", "brave", makeSettings("brave"))
    expect(r.query).toBe("images")
  })

  it("searchVideos routes videos", async () => {
    const r = await searchVideos("q", "serper", makeSettings("serper"))
    expect(r.query).toBe("videos")
  })

  it("searchAcademic routes academic", async () => {
    const r = await searchAcademic("q", "searchapi", makeSettings("searchapi"))
    expect(r.query).toBe("academic")
  })
})

describe("findSimilar / getContents", () => {
  it("findSimilar delegates to exa", async () => {
    const r = await findSimilar("https://example.com", "key-1234567890")
    expect(r.provider).toBe("exa")
  })

  it("getContents wraps exa contents into a SearchResponse", async () => {
    const r = await getContents(["https://example.com"], "key-1234567890")
    expect(r.provider).toBe("exa")
    expect(r.results).toHaveLength(1)
    expect(r.totalResults).toBe(1)
  })
})

describe("autoRouteSearch", () => {
  it("throws when no provider available", async () => {
    await expect(autoRouteSearch("q", "videos", {})).rejects.toThrow(/No enabled provider/)
  })

  it("routes to the best provider", async () => {
    const r = await autoRouteSearch("q", "news", {
      brave: makeSettings("brave"),
    })
    expect(r.query).toBe("news")
  })
})

describe("effective capabilities", () => {
  it("agree with every provider's advertised feature badges", () => {
    for (const id of Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]) {
      if (SEARCH_PROVIDERS[id].lifecycle.status === "retired") continue
      const caps = getEffectiveSearchCapabilities(id)!
      const f = SEARCH_PROVIDERS[id].features
      expect({ id, news: caps.types.includes("news") }).toEqual({ id, news: f.newsSearch })
      expect({ id, academic: caps.types.includes("academic") }).toEqual({
        id,
        academic: f.academicSearch,
      })
      expect({ id, images: caps.types.includes("images") }).toEqual({ id, images: f.imageSearch })
      expect({ id, videos: caps.types.includes("videos") }).toEqual({ id, videos: f.videoSearch })
      expect({ id, recency: caps.controls.recency }).toEqual({ id, recency: f.recencyFilter })
    }
  })

  it("lists engines only for engine-capable providers", () => {
    expect(getEffectiveSearchCapabilities("searchapi")!.engines.map((e) => e.id)).toContain("baidu")
    expect(getEffectiveSearchCapabilities("brave")!.engines).toEqual([])
    expect(getEffectiveSearchCapabilities("searxng")!.freeFormEngines).toBe(true)
  })
})

describe("eligibility", () => {
  it("rejects an engine a provider does not list", () => {
    expect(checkProviderEligibility("searchapi", undefined, { engine: "altavista" })?.reason).toBe(
      "unsupported-engine"
    )
    expect(checkProviderEligibility("searchapi", undefined, { engine: "bing" })).toBeNull()
    expect(checkProviderEligibility("brave", undefined, { engine: "bing" })?.reason).toBe(
      "unsupported-engine"
    )
  })

  it("only lets the default engine pair with a vertical type", () => {
    expect(
      checkProviderEligibility("searchapi", undefined, { engine: "bing", searchType: "news" })
        ?.reason
    ).toBe("unsupported-engine")
    expect(
      checkProviderEligibility("searchapi", undefined, { engine: "google", searchType: "news" })
    ).toBeNull()
  })

  it("treats strict and required-moderate safe search as mandatory", () => {
    expect(checkProviderEligibility("exa", undefined, { safeSearch: "strict" })?.reason).toBe(
      "safe-search-unenforceable"
    )
    expect(checkProviderEligibility("exa", undefined, { safeSearch: "moderate" })).toBeNull()
    expect(
      checkProviderEligibility("exa", undefined, {
        safeSearch: "moderate",
        safeSearchRequired: true,
      })?.reason
    ).toBe("safe-search-unenforceable")
    expect(checkProviderEligibility("brave", undefined, { safeSearch: "strict" })).toBeNull()
  })

  it("never lets a retired provider run", () => {
    expect(checkProviderEligibility("bing", undefined, {})?.reason).toBe("retired")
  })

  it("discloses advisory controls an adapter cannot carry", () => {
    expect(degradedControlsFor("exa", { safeSearch: "moderate", country: "us" })).toEqual([
      "safeSearch",
      "country",
    ])
    expect(degradedControlsFor("brave", { safeSearch: "moderate", country: "us" })).toEqual([])
  })
})

describe("wire mapping", () => {
  it("passes the canonical safe-search level to Brave's native field", async () => {
    await routeSearch("q", "brave", makeSettings("brave"), { safeSearch: "strict" })
    expect(searchWithBrave).toHaveBeenLastCalledWith(
      "q",
      expect.any(String),
      expect.objectContaining({ safesearch: "strict" })
    )
  })

  it("passes Google safe search through instead of dropping it", async () => {
    await routeSearch("q", "google", makeSettings("google", { cx: "abc" }), { safeSearch: "off" })
    expect(searchWithGoogle).toHaveBeenLastCalledWith(
      "q",
      expect.any(String),
      expect.objectContaining({ safe: "off" })
    )
  })

  it("routes the configured engine to SearchAPI and reports it", async () => {
    const r = await routeSearch("q", "searchapi", makeSettings("searchapi", { engine: "baidu" }))
    expect(searchWithSearchAPI).toHaveBeenLastCalledWith(
      "q",
      expect.any(String),
      expect.objectContaining({ engine: "baidu" })
    )
    expect(r.engine).toBe("baidu")
    expect(resolveEngine("searchapi", undefined, {})).toBe("google")
  })
})
