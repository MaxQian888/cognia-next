import {
  extractDomain,
  getRootDomain,
  determineSourceType,
  calculateCredibilityScore,
  getCredibilityLevel,
  getTrustIndicators,
  getWarningIndicators,
  verifySource,
  verifySearchResults,
  calculateTextSimilarity,
  extractKeyClaims,
  crossValidateContent,
  generateVerificationReport,
  filterByCredibility,
  sortByCredibility,
  calculateSourceDiversity,
  applySourceVerificationPolicy,
} from "./source-verification"
import type { SearchResponse, SearchResult } from "./types"

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: "Result",
    url: "https://example.com/page",
    content: "Some content here.",
    score: 1,
    ...overrides,
  }
}

describe("extractDomain", () => {
  it("strips www and lowercases", () => {
    expect(extractDomain("https://WWW.Example.com/path")).toBe("example.com")
  })

  it("returns lowercase fallback for invalid URL", () => {
    expect(extractDomain("not a url")).toBe("not a url")
  })
})

describe("getRootDomain", () => {
  it("returns same value for short domains", () => {
    expect(getRootDomain("example.com")).toBe("example.com")
  })

  it("returns last 2 parts for normal subdomain", () => {
    expect(getRootDomain("api.example.com")).toBe("example.com")
  })

  it("preserves third part for special TLDs", () => {
    expect(getRootDomain("subdomain.example.co.uk")).toBe("example.co.uk")
    expect(getRootDomain("foo.gov.uk")).toBe("foo.gov.uk")
  })
})

describe("determineSourceType", () => {
  it("recognizes government domains", () => {
    expect(determineSourceType("cdc.gov")).toBe("government")
    expect(determineSourceType("gov.cn")).toBe("government")
    expect(determineSourceType("foo.gov.uk")).toBe("government")
  })

  it("recognizes academic domains", () => {
    expect(determineSourceType("mit.edu")).toBe("academic")
    expect(determineSourceType("arxiv.org")).toBe("academic")
    expect(determineSourceType("foo.ac.uk")).toBe("academic")
  })

  it("recognizes news domains", () => {
    expect(determineSourceType("nytimes.com")).toBe("news")
  })

  it("recognizes encyclopedia domains", () => {
    expect(determineSourceType("en.wikipedia.org")).toBe("encyclopedia")
  })

  it("recognizes social, blog, forum, ecommerce", () => {
    expect(determineSourceType("twitter.com")).toBe("social")
    expect(determineSourceType("medium.com")).toBe("blog")
    expect(determineSourceType("stackoverflow.com")).toBe("forum")
  })

  it("falls back to unknown", () => {
    expect(determineSourceType("randomsite12345.zzz")).toBe("unknown")
  })
})

describe("calculateCredibilityScore", () => {
  it("rewards high-trust types and HTTPS", () => {
    const govScore = calculateCredibilityScore("cdc.gov", "government", true)
    const blogScore = calculateCredibilityScore("medium.com", "blog", true)
    expect(govScore).toBeGreaterThan(blogScore)
  })

  it("penalizes non-HTTPS", () => {
    const a = calculateCredibilityScore("example.com", "official", true)
    const b = calculateCredibilityScore("example.com", "official", false)
    expect(a).toBeGreaterThan(b)
  })

  it("penalizes suspicious patterns", () => {
    const score = calculateCredibilityScore("free-download12345.tk", "unknown", true)
    expect(score).toBeLessThan(50)
  })

  it("clamps to [0, 100]", () => {
    const high = calculateCredibilityScore("cdc.gov", "government", true)
    const low = calculateCredibilityScore("a".repeat(60), "unknown", false)
    expect(high).toBeLessThanOrEqual(100)
    expect(low).toBeGreaterThanOrEqual(0)
  })

  it("penalizes excessive subdomains", () => {
    const a = calculateCredibilityScore("example.com", "unknown", true)
    const b = calculateCredibilityScore("a.b.c.d.example.com", "unknown", true)
    expect(a).toBeGreaterThan(b)
  })
})

describe("getCredibilityLevel", () => {
  it("buckets correctly", () => {
    expect(getCredibilityLevel(90)).toBe("high")
    expect(getCredibilityLevel(60)).toBe("medium")
    expect(getCredibilityLevel(30)).toBe("low")
    expect(getCredibilityLevel(10)).toBe("unknown")
  })
})

describe("getTrustIndicators / getWarningIndicators", () => {
  it("trust indicators include HTTPS", () => {
    const ind = getTrustIndicators("example.com", "official", true)
    expect(ind).toContain("Secure HTTPS connection")
  })

  it("warning indicators include non-HTTPS", () => {
    const w = getWarningIndicators("example.com", "unknown", false)
    expect(w).toContain("Not using secure HTTPS connection")
  })

  it("warns about suspicious domain patterns", () => {
    const w = getWarningIndicators("free-download.tk", "unknown", true)
    expect(w.some((x) => x.includes("suspicious"))).toBe(true)
  })

  it("warns about complex domain structure", () => {
    const w = getWarningIndicators("a.b.c.d.e.com", "unknown", true)
    expect(w.some((x) => x.includes("complex"))).toBe(true)
  })

  it("includes type-specific labels", () => {
    expect(getTrustIndicators("cdc.gov", "government", true)).toEqual(
      expect.arrayContaining([expect.stringContaining("government")])
    )
    expect(getTrustIndicators("mit.edu", "academic", true)).toEqual(
      expect.arrayContaining([expect.stringContaining("Academic")])
    )
    expect(getTrustIndicators("nytimes.com", "news", true)).toEqual(
      expect.arrayContaining([expect.stringContaining("news")])
    )
    expect(getTrustIndicators("wikipedia.org", "encyclopedia", true)).toEqual(
      expect.arrayContaining([expect.stringContaining("encyclopedia")])
    )
  })

  it("includes well-known platform marker", () => {
    expect(getTrustIndicators("github.com", "official", true)).toEqual(
      expect.arrayContaining([expect.stringContaining("Well-established")])
    )
  })

  it("warns about social/blog/forum/unknown sources", () => {
    expect(getWarningIndicators("twitter.com", "social", true)).toEqual(
      expect.arrayContaining([expect.stringContaining("Social media")])
    )
    expect(getWarningIndicators("medium.com", "blog", true)).toEqual(
      expect.arrayContaining([expect.stringContaining("Personal blog")])
    )
    expect(getWarningIndicators("reddit.com", "forum", true)).toEqual(
      expect.arrayContaining([expect.stringContaining("Forum")])
    )
    expect(getWarningIndicators("xyz.zzz", "unknown", true)).toEqual(
      expect.arrayContaining([expect.stringContaining("Unknown")])
    )
  })
})

describe("verifySource", () => {
  it("returns a complete verification result", () => {
    const r = verifySource("https://www.example.com/path")
    expect(r.url).toBe("https://www.example.com/path")
    expect(r.domain).toBe("example.com")
    expect(r.isHttps).toBe(true)
    expect(typeof r.credibilityScore).toBe("number")
  })
})

describe("verifySearchResults", () => {
  it("verifies all results", () => {
    const results = [makeResult({ url: "https://a.com" }), makeResult({ url: "https://b.com" })]
    expect(verifySearchResults(results)).toHaveLength(2)
  })
})

describe("calculateTextSimilarity", () => {
  it("returns 0 when either text empties", () => {
    expect(calculateTextSimilarity("", "anything here")).toBe(0)
    expect(calculateTextSimilarity("hi", "")).toBe(0)
  })

  it("returns 1 for identical text", () => {
    expect(calculateTextSimilarity("react hooks tutorial", "react hooks tutorial")).toBe(1)
  })

  it("returns a fraction for partial overlap", () => {
    const sim = calculateTextSimilarity("react hooks tutorial guide", "react hooks framework guide")
    expect(sim).toBeGreaterThan(0)
    expect(sim).toBeLessThan(1)
  })

  it("ignores short words and punctuation", () => {
    expect(calculateTextSimilarity("the a", "an of")).toBe(0)
  })
})

describe("extractKeyClaims", () => {
  it("returns sentences with factual patterns", () => {
    const text =
      "TypeScript was released in 2012. The economy grew by 5 percent. Hello there. Studies indicate strong growth."
    const claims = extractKeyClaims(text)
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.length).toBeLessThanOrEqual(10)
  })

  it("ignores too-short or too-long sentences", () => {
    const text = "Hi. " + "a".repeat(600) + ". This is a meaningful sentence with 5 facts."
    const claims = extractKeyClaims(text)
    expect(claims.every((c) => c.length >= 20 && c.length < 500)).toBe(true)
  })
})

describe("crossValidateContent", () => {
  it("returns weak consensus for empty input", () => {
    const r = crossValidateContent([])
    expect(r.consensusLevel).toBe("weak")
    expect(r.confidenceScore).toBe(0)
    expect(r.validationSummary).toMatch(/No results/)
  })

  it("computes strong consensus when all support", () => {
    const results = [
      makeResult({ content: "react hooks tutorial guide foo bar baz" }),
      makeResult({ content: "react hooks tutorial guide foo bar baz extra" }),
      makeResult({ content: "react hooks tutorial guide foo bar baz again" }),
    ]
    const r = crossValidateContent(results)
    expect(["strong", "moderate"]).toContain(r.consensusLevel)
  })

  it("detects contradiction keywords", () => {
    const results = [
      makeResult({ content: "react frameworks guide" }),
      makeResult({ content: "however, this is contrary; the result is false" }),
      makeResult({ content: "however, the data is incorrect dispute" }),
    ]
    const r = crossValidateContent(results, "react frameworks tutorial")
    expect(["conflicting", "weak", "moderate"]).toContain(r.consensusLevel)
    expect(typeof r.validationSummary).toBe("string")
  })

  it("uses claim when provided", () => {
    const results = [makeResult({ content: "supports the claim x y z" })]
    const r = crossValidateContent(results, "important claim")
    expect(r.claim).toBe("important claim")
  })
})

describe("generateVerificationReport", () => {
  function makeResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
    return {
      provider: "tavily",
      query: "react",
      results: [
        makeResult({ url: "https://en.wikipedia.org/wiki/React" }),
        makeResult({ url: "https://github.com/facebook/react" }),
      ],
      responseTime: 1,
      ...overrides,
    }
  }

  it("returns recommendations and overall score", () => {
    const report = generateVerificationReport(makeResponse())
    expect(report.totalResults).toBe(2)
    expect(report.sourceVerifications).toHaveLength(2)
    expect(typeof report.overallCredibilityScore).toBe("number")
    expect(report.recommendations.length).toBeGreaterThan(0)
  })

  it("recommends searching official sources when no high-credibility found", () => {
    const report = generateVerificationReport(
      makeResponse({
        results: [makeResult({ url: "http://blog.example.com" })],
      })
    )
    expect(report.recommendations.some((r) => r.includes("official"))).toBe(true)
  })

  it("warns about unsecure sources", () => {
    const report = generateVerificationReport(
      makeResponse({
        results: [makeResult({ url: "http://blog.example.com" })],
      })
    )
    expect(report.recommendations.some((r) => r.includes("HTTPS"))).toBe(true)
  })

  it("returns 0 score when no results", () => {
    const report = generateVerificationReport(makeResponse({ results: [] }))
    expect(report.overallCredibilityScore).toBe(0)
  })
})

describe("filterByCredibility", () => {
  it("keeps only items at or above the level", () => {
    const high = makeResult({ url: "https://cdc.gov" })
    const blog = makeResult({ url: "http://blog.example.tk" })
    const filtered = filterByCredibility([high, blog], "high")
    expect(filtered.map((r) => r.url)).toEqual(["https://cdc.gov"])
  })
})

describe("sortByCredibility", () => {
  it("descending by default", () => {
    const high = makeResult({ url: "https://cdc.gov" })
    const blog = makeResult({ url: "http://blog.example.tk" })
    const sorted = sortByCredibility([blog, high])
    expect(sorted[0].url).toBe("https://cdc.gov")
  })

  it("supports ascending order", () => {
    const high = makeResult({ url: "https://cdc.gov" })
    const blog = makeResult({ url: "http://blog.example.tk" })
    const sorted = sortByCredibility([high, blog], "asc")
    expect(sorted[0].url).toBe("http://blog.example.tk")
  })
})

describe("calculateSourceDiversity", () => {
  it("returns 0 for empty list", () => {
    expect(calculateSourceDiversity([])).toBe(0)
  })

  it("rewards mix of domains and types", () => {
    const div1 = calculateSourceDiversity([
      makeResult({ url: "https://a.com" }),
      makeResult({ url: "https://a.com/2" }),
      makeResult({ url: "https://a.com/3" }),
    ])
    const div2 = calculateSourceDiversity([
      makeResult({ url: "https://cdc.gov" }),
      makeResult({ url: "https://wikipedia.org" }),
      makeResult({ url: "https://nytimes.com" }),
      makeResult({ url: "https://github.com" }),
    ])
    expect(div2).toBeGreaterThan(div1)
  })
})

describe("applySourceVerificationPolicy", () => {
  const high = makeResult({ url: "https://cdc.gov/health" })
  const unknown = makeResult({ url: "https://news.unknown-example.test/story" })

  it("is a no-op when verification is disabled", () => {
    const results = [unknown, high]
    expect(applySourceVerificationPolicy(results, { enabled: false })).toBe(results)
  })

  it("blocks exact domains and their subdomains", () => {
    const results = [
      high,
      makeResult({ url: "https://spam.test/a" }),
      makeResult({ url: "https://sub.spam.test/b" }),
    ]
    expect(
      applySourceVerificationPolicy(results, {
        enabled: true,
        blockedDomains: ["HTTPS://SPAM.TEST/path"],
      }).map((result) => result.url)
    ).toEqual([high.url])
  })

  it("applies normalized minimum credibility and sorts highest first", () => {
    expect(
      applySourceVerificationPolicy([unknown, high], {
        enabled: true,
        autoFilterLowCredibility: true,
        minimumCredibilityScore: 0.75,
      }).map((result) => result.url)
    ).toEqual([high.url])
  })

  it("accepts a legacy 0-100 credibility threshold", () => {
    expect(
      applySourceVerificationPolicy([unknown, high], {
        enabled: true,
        autoFilterLowCredibility: true,
        minimumCredibilityScore: 75,
      }).map((result) => result.url)
    ).toEqual([high.url])
  })
})
