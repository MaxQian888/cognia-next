import { webFetch, webSearch, buildFetchExtractor } from "./web-tools-core"

jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
}))
jest.mock("@cognia/document/parsers/html-parser", () => ({
  parseHTML: jest.fn(async () => ({ text: "readable text", title: "Title" })),
}))
jest.mock("@/lib/search/types", () => ({
  DEFAULT_SEARCH_PROVIDER_SETTINGS: {},
  isProviderConfigured: jest.fn((_id: string, p: { apiKey?: string }) => Boolean(p?.apiKey)),
}))

import { search } from "@/lib/search/search-service"
import { parseHTML } from "@cognia/document/parsers/html-parser"

const mockSearch = search as jest.Mock
const mockParseHTML = parseHTML as jest.Mock

function res(body: string, contentType = "text/html", ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: new Headers({ "content-type": contentType }),
    text: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  mockParseHTML.mockReset()
  mockParseHTML.mockResolvedValue({ text: "readable text", title: "Title" })
})

describe("webFetch", () => {
  it("requires a url", async () => {
    expect(await webFetch({ url: "" })).toEqual({ ok: false, error: "url is required" })
  })

  it("returns extracted text (NOT the raw body) for HTML responses", async () => {
    const fetchImpl = jest.fn(async () => res("<html><body>hi</body></html>"))
    const out = (await webFetch({ url: "https://x.test" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(out.ok).toBe(true)
    // Raw (non-distilled) page text is framed as untrusted for injection safety.
    expect(out.text).toContain("readable text")
    expect(out.text).toContain("Untrusted web content")
    expect(out.title).toBe("Title")
    expect(out.contentType).toBe("text/html")
    // The raw HTML markup must NOT be sent to the model.
    expect(out.body).toBeUndefined()
    expect(mockParseHTML).toHaveBeenCalled()
  })

  it("returns the raw body in raw mode (no extraction)", async () => {
    const fetchImpl = jest.fn(async () => res("<html>x</html>"))
    const out = (await webFetch({ url: "https://x.test", format: "raw" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(out.text).toBeUndefined()
    expect(out.body).toBe("<html>x</html>")
    expect(mockParseHTML).not.toHaveBeenCalled()
  })

  it("uses the X/Twitter platform scraper for x.com status URLs", async () => {
    const fetchImpl = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => "",
          json: async () => ({
            tweet: { text: "a tweet", author: { name: "Jane", screen_name: "jane" } },
          }),
        }) as unknown as Response
    )
    const out = (await webFetch(
      { url: "https://x.com/jane/status/1" },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )) as Record<string, unknown>
    expect(out.source).toBe("x")
    expect(out.text).toContain("a tweet")
    expect(fetchImpl).toHaveBeenCalledWith("https://api.fxtwitter.com/status/1", expect.anything())
    // Generic extraction is bypassed for the scraper path.
    expect(mockParseHTML).not.toHaveBeenCalled()
  })

  it("falls back to Jina when local extraction is thin and jinaFallback is on", async () => {
    mockParseHTML.mockResolvedValue({ text: "", title: undefined })
    const fetchImpl = jest.fn(async (url: string) =>
      url.startsWith("https://r.jina.ai/")
        ? res("Title: JT\nMarkdown Content:\n" + "x".repeat(300), "text/plain")
        : res("<html><body></body></html>")
    )
    const out = (await webFetch(
      { url: "https://spa.test" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, jinaFallback: true }
    )) as Record<string, unknown>
    expect(out.source).toBe("jina")
    expect(out.title).toBe("JT")
    expect(String(out.text).endsWith("x".repeat(300))).toBe(true)
  })

  it("does not reach Jina by default (privacy)", async () => {
    mockParseHTML.mockResolvedValue({ text: "short", title: "T" })
    const fetchImpl = jest.fn(async () => res("<html><body>hi</body></html>"))
    await webFetch({ url: "https://x.test" }, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).not.toHaveBeenCalledWith(
      expect.stringContaining("r.jina.ai"),
      expect.anything()
    )
  })

  it("returns the raw body for non-HTML responses", async () => {
    const fetchImpl = jest.fn(async () => res('{"a":1}', "application/json"))
    const out = (await webFetch({ url: "https://x.test/api" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(out.body).toBe('{"a":1}')
    expect(out.text).toBeUndefined()
    expect(mockParseHTML).not.toHaveBeenCalled()
  })

  it("falls back to the raw body when HTML extraction yields nothing", async () => {
    mockParseHTML.mockResolvedValue({ text: "   ", title: undefined })
    const fetchImpl = jest.fn(async () => res("<html></html>"))
    const out = (await webFetch({ url: "https://x.test" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(out.body).toBe("<html></html>")
    expect(out.text).toBeUndefined()
  })

  it("falls back to the raw body when the HTML parser throws", async () => {
    mockParseHTML.mockRejectedValue(new Error("bad html"))
    const fetchImpl = jest.fn(async () => res("<html>oops</html>"))
    const out = (await webFetch({ url: "https://x.test" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(out.body).toBe("<html>oops</html>")
    expect(out.text).toBeUndefined()
  })

  it("applies a User-Agent header and a byte cap to the raw body", async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) =>
      res("abcdefgh", "text/plain")
    )
    const out = (await webFetch(
      { url: "https://x.test", maxBytes: 4 },
      { fetchImpl: fetchImpl as unknown as typeof fetch, userAgent: "Cognia/1" }
    )) as Record<string, unknown>
    expect(out.body).toBe("abcd")
    expect(out.truncated).toBe(true)
    const headers = (fetchImpl.mock.calls[0][1]?.headers ?? {}) as Record<string, string>
    expect(headers["User-Agent"]).toBe("Cognia/1")
  })

  it("caps extracted text at the default extract limit", async () => {
    mockParseHTML.mockResolvedValue({ text: "x".repeat(50_000), title: "T" })
    const fetchImpl = jest.fn(async () => res("<html>big</html>"))
    const out = (await webFetch({ url: "https://x.test" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    // Cap applies to the content; the untrusted banner is added on top of it.
    const content = (out.text as string).replace(/^\[Untrusted[^\]]*\]\n\n/, "")
    expect(content.length).toBe(40 * 1024)
    expect(out.truncated).toBe(true)
  })

  it("respects a preset User-Agent and a maxBytes extract cap for HTML", async () => {
    mockParseHTML.mockResolvedValue({ text: "y".repeat(20), title: undefined })
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) => res("<html>big</html>"))
    const out = (await webFetch(
      { url: "https://x.test", maxBytes: 8, headers: { "User-Agent": "Preset/9" } },
      { fetchImpl: fetchImpl as unknown as typeof fetch, userAgent: "Cognia/1" }
    )) as Record<string, unknown>
    // maxBytes set → extract cap follows it (banner excluded from the cap).
    const content = (out.text as string).replace(/^\[Untrusted[^\]]*\]\n\n/, "")
    expect(content.length).toBe(8)
    expect(out.truncated).toBe(true)
    // No title returned when the parser found none.
    expect(out.title).toBeUndefined()
    const headers = (fetchImpl.mock.calls[0][1]?.headers ?? {}) as Record<string, string>
    expect(headers["User-Agent"]).toBe("Preset/9")
  })

  it("distills the page to the prompt when a summarizer is provided", async () => {
    const fetchImpl = jest.fn(async () => res("<html>full page</html>"))
    const summarize = jest.fn(async () => "FOCUSED ANSWER")
    const out = (await webFetch(
      { url: "https://x.test", prompt: "what is x?" },
      { fetchImpl, summarize }
    )) as Record<string, unknown>
    expect(out.text).toBe("FOCUSED ANSWER")
    expect(summarize).toHaveBeenCalledWith("readable text", "what is x?", undefined)
  })

  it("forwards the abort signal to the summarizer", async () => {
    const controller = new AbortController()
    const fetchImpl = jest.fn(async () => res("<html>full page</html>"))
    const summarize = jest.fn(async () => "FOCUSED")
    await webFetch(
      { url: "https://x.test", prompt: "q" },
      { fetchImpl, summarize, signal: controller.signal }
    )
    expect(summarize).toHaveBeenCalledWith("readable text", "q", controller.signal)
  })

  it("falls back to extracted text when the summarizer throws", async () => {
    const fetchImpl = jest.fn(async () => res("<html>full page</html>"))
    const summarize = jest.fn(async () => {
      throw new Error("model down")
    })
    const out = (await webFetch(
      { url: "https://x.test", prompt: "what is x?" },
      { fetchImpl, summarize }
    )) as Record<string, unknown>
    // Fell back to extracted text → framed as untrusted.
    expect(out.text).toContain("readable text")
    expect(out.text).toContain("Untrusted web content")
  })

  it("ignores the prompt when no summarizer is available", async () => {
    const fetchImpl = jest.fn(async () => res("<html>full page</html>"))
    const out = (await webFetch(
      { url: "https://x.test", prompt: "what is x?" },
      { fetchImpl }
    )) as Record<string, unknown>
    expect(out.text).toContain("readable text")
  })

  it("distilled output is NOT wrapped as untrusted", async () => {
    const fetchImpl = jest.fn(async () => res("<html>full page</html>"))
    const summarize = jest.fn(async () => "FOCUSED ANSWER")
    const out = (await webFetch(
      { url: "https://x.test", prompt: "what is x?" },
      { fetchImpl, summarize }
    )) as Record<string, unknown>
    expect(out.text).toBe("FOCUSED ANSWER")
    expect(out.text).not.toContain("Untrusted web content")
  })

  it("alwaysDistill runs the summarizer with a generic prompt when no prompt is given", async () => {
    const fetchImpl = jest.fn(async () => res("<html>full page</html>"))
    const summarize = jest.fn(async () => "GENERIC SUMMARY")
    const out = (await webFetch(
      { url: "https://x.test" },
      { fetchImpl, summarize, alwaysDistill: true }
    )) as Record<string, unknown>
    expect(out.text).toBe("GENERIC SUMMARY")
    expect(summarize).toHaveBeenCalledWith(
      "readable text",
      expect.stringMatching(/key facts/i),
      undefined
    )
  })

  it("serves a repeated GET from the cache without re-fetching", async () => {
    const store = new Map<string, unknown>()
    const cache = {
      get: (k: string) => (store.has(k) ? store.get(k) : null),
      set: (k: string, v: unknown) => void store.set(k, v),
    }
    const fetchImpl = jest.fn(async () => res("<html>cached</html>"))
    const first = await webFetch({ url: "https://x.test/c" }, { fetchImpl, cache })
    const second = await webFetch({ url: "https://x.test/c" }, { fetchImpl, cache })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it("does not cache non-GET requests", async () => {
    const store = new Map<string, unknown>()
    const cache = {
      get: (k: string) => (store.has(k) ? store.get(k) : null),
      set: (k: string, v: unknown) => void store.set(k, v),
    }
    const fetchImpl = jest.fn(async () => res("ok", "text/plain"))
    await webFetch({ url: "https://x.test/p", method: "POST", body: "{}" }, { fetchImpl, cache })
    await webFetch({ url: "https://x.test/p", method: "POST", body: "{}" }, { fetchImpl, cache })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(store.size).toBe(0)
  })

  it("does not cache a failed response", async () => {
    const store = new Map<string, unknown>()
    const cache = {
      get: (k: string) => (store.has(k) ? store.get(k) : null),
      set: (k: string, v: unknown) => void store.set(k, v),
    }
    const fetchImpl = jest.fn(async () => res("nope", "text/plain", false, 500))
    await webFetch({ url: "https://x.test/e" }, { fetchImpl, cache })
    expect(store.size).toBe(0)
  })

  it("returns a structured error when fetch throws", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("network down")
    })
    expect(await webFetch({ url: "https://x.test" }, { fetchImpl })).toEqual({
      ok: false,
      error: "network down",
    })
  })

  it("blocks a private/loopback host by default (SSRF guard) without fetching", async () => {
    const fetchImpl = jest.fn(async () => res("<html>secret</html>"))
    const out = (await webFetch(
      { url: "http://169.254.169.254/latest/" },
      { fetchImpl }
    )) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/private\/loopback/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("blocks a non-http(s) scheme", async () => {
    const fetchImpl = jest.fn(async () => res("x"))
    const out = (await webFetch({ url: "file:///etc/passwd" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(out.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("allows a private host when allowPrivateHosts is enabled", async () => {
    const fetchImpl = jest.fn(async () => res("<html><body>ok</body></html>"))
    const out = (await webFetch(
      { url: "http://localhost:3000/" },
      { fetchImpl, allowPrivateHosts: true }
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalled()
  })

  it("returns a binary note (not garbage) for non-text content", async () => {
    const fetchImpl = jest.fn(async () => res("\x00\x01PNGdata", "image/png"))
    const out = (await webFetch({ url: "https://x.test/logo.png" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(out.binary).toBe(true)
    expect(out.body).toBeUndefined()
    expect(out.text).toBeUndefined()
    expect(String(out.note)).toMatch(/binary/i)
    expect(mockParseHTML).not.toHaveBeenCalled()
  })

  it("routes a PDF through Jina when the fallback is enabled", async () => {
    const fetchImpl = jest.fn(async (url: string) =>
      url.startsWith("https://r.jina.ai/")
        ? res("Title: Doc\nMarkdown Content:\n# PDF as markdown", "text/plain")
        : res("%PDF-1.7 binary", "application/pdf")
    )
    const out = (await webFetch(
      { url: "https://x.test/report.pdf" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, jinaFallback: true }
    )) as Record<string, unknown>
    expect(out.source).toBe("jina")
    expect(String(out.text)).toContain("PDF as markdown")
    expect(out.binary).toBeUndefined()
  })

  it("reports a PDF as binary when Jina is disabled", async () => {
    const fetchImpl = jest.fn(async () => res("%PDF-1.7 binary", "application/pdf"))
    const out = (await webFetch({ url: "https://x.test/report.pdf" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(out.binary).toBe(true)
    expect(String(out.note)).toMatch(/pdf/i)
  })

  it("returns raw bytes for binary content when format is raw", async () => {
    const fetchImpl = jest.fn(async () => res("rawpngbytes", "image/png"))
    const out = (await webFetch(
      { url: "https://x.test/logo.png", format: "raw" },
      { fetchImpl }
    )) as Record<string, unknown>
    expect(out.binary).toBeUndefined()
    expect(out.body).toBe("rawpngbytes")
  })

  it("pages a long page via offset and reports totalLength + nextOffset", async () => {
    mockParseHTML.mockResolvedValue({ text: "x".repeat(50_000), title: "T" })
    const fetchImpl = jest.fn(async () => res("<html>big</html>"))
    const first = (await webFetch({ url: "https://x.test" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(first.truncated).toBe(true)
    expect(first.totalLength).toBe(50_000)
    expect(first.nextOffset).toBe(40 * 1024)

    const second = (await webFetch(
      { url: "https://x.test", offset: 40 * 1024 },
      { fetchImpl }
    )) as Record<string, unknown>
    // The remaining 50000 - 40960 = 9040 chars fit → not truncated, no nextOffset.
    expect(second.truncated).toBe(false)
    expect(second.nextOffset).toBeUndefined()
    const content = (second.text as string).replace(/^\[Untrusted[^\]]*\]\n\n/, "")
    expect(content.length).toBe(50_000 - 40 * 1024)
  })

  it("windows the raw body path by offset", async () => {
    const fetchImpl = jest.fn(async () => res("0123456789", "text/plain"))
    const out = (await webFetch(
      { url: "https://x.test/data", maxBytes: 4, offset: 4 },
      { fetchImpl }
    )) as Record<string, unknown>
    expect(out.body).toBe("4567")
    expect(out.truncated).toBe(true)
    expect(out.totalLength).toBe(10)
    expect(out.nextOffset).toBe(8)
  })
})

describe("buildFetchExtractor", () => {
  it("calls the client with the system prompt and returns trimmed output", async () => {
    const complete = jest.fn(
      async (_prompt: string, _options?: { system?: string }) => "  the answer  "
    )
    const extract = buildFetchExtractor({ complete })
    const out = await extract("page text", "what?")
    expect(out).toBe("the answer")
    const [prompt, options] = complete.mock.calls[0]
    expect(prompt).toContain("what?")
    expect(prompt).toContain("page text")
    expect(options?.system).toMatch(/extract only/i)
  })

  it("bounds the page text fed to the model", async () => {
    const complete = jest.fn(async (_prompt: string) => "ok")
    const extract = buildFetchExtractor({ complete })
    await extract("y".repeat(100_000), "q")
    const [prompt] = complete.mock.calls[0]
    // 32 KB input cap + the wrapper text, well under the full 100k page.
    expect(prompt.length).toBeLessThan(33 * 1024 + 200)
  })

  it("tolerates a nullish completion", async () => {
    const complete = jest.fn(async () => undefined as unknown as string)
    const extract = buildFetchExtractor({ complete })
    expect(await extract("text", "q")).toBe("")
  })
})

describe("webSearch", () => {
  beforeEach(() => mockSearch.mockReset())

  it("requires a query", async () => {
    expect(await webSearch({ query: "  " })).toEqual({ ok: false, error: "query is required" })
  })

  it("errors when no provider is configured", async () => {
    const out = (await webSearch(
      { query: "hi" },
      { providerSettings: { tavily: { providerId: "tavily", enabled: true } } as never }
    )) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/No web search provider/)
  })

  it("returns structured results without a duplicate formatted block", async () => {
    mockSearch.mockResolvedValue({
      provider: "tavily",
      answer: "the answer",
      results: [{ title: "T", url: "u", content: "c", score: 0.9 }],
    })
    const out = (await webSearch(
      { query: "hi", maxResults: 3 },
      {
        providerSettings: {
          tavily: { providerId: "tavily", enabled: true, apiKey: "k" },
        } as never,
      }
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(out.provider).toBe("tavily")
    // The duplicate markdown re-serialization is gone.
    expect(out.formatted).toBeUndefined()
    expect((out.results as unknown[]).length).toBe(1)
    expect(mockSearch).toHaveBeenCalledWith("hi", expect.objectContaining({ maxResults: 3 }))
  })

  it("truncates long per-result snippets", async () => {
    mockSearch.mockResolvedValue({
      provider: "tavily",
      answer: null,
      results: [{ title: "T", url: "u", content: "z".repeat(500), score: 0.5 }],
    })
    const out = (await webSearch(
      { query: "hi" },
      {
        providerSettings: { tavily: { providerId: "tavily", enabled: true, apiKey: "k" } } as never,
      }
    )) as Record<string, unknown>
    const first = (out.results as { content: string }[])[0]
    expect(first.content.length).toBe(301) // 300 chars + ellipsis
    expect(first.content.endsWith("…")).toBe(true)
  })

  it("honors a forced provider + deps.searchMaxResults and keeps publishedDate", async () => {
    mockSearch.mockResolvedValue({
      provider: "exa",
      answer: null,
      results: [
        { title: "T", url: "u", content: "c", score: 0.5, publishedDate: "2026-01-01" },
        { title: "T2", url: "u2", content: undefined, score: 0.4 },
      ],
    })
    const out = (await webSearch(
      { query: "hi", provider: "exa" as never },
      {
        providerSettings: { exa: { providerId: "exa", enabled: true, apiKey: "k" } } as never,
        searchMaxResults: 7,
      }
    )) as Record<string, unknown>
    expect(mockSearch).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ provider: "exa", maxResults: 7 })
    )
    const rows = out.results as { publishedDate?: string; content: unknown }[]
    expect(rows[0].publishedDate).toBe("2026-01-01")
    expect(rows[1].content).toBeUndefined()
    expect(out.answer).toBeNull()
  })

  const cfg = {
    providerSettings: { tavily: { providerId: "tavily", enabled: true, apiKey: "k" } } as never,
  }

  it("strips filler from the query before searching", async () => {
    mockSearch.mockResolvedValue({ provider: "tavily", answer: null, results: [] })
    const out = (await webSearch({ query: "please tell me about TypeScript" }, cfg)) as Record<
      string,
      unknown
    >
    expect(mockSearch).toHaveBeenCalledWith("tell me about TypeScript", expect.anything())
    expect(out.query).toBe("tell me about TypeScript")
  })

  it("leaves the query untouched when optimizeQuery is false", async () => {
    mockSearch.mockResolvedValue({ provider: "tavily", answer: null, results: [] })
    await webSearch({ query: "please tell me about TypeScript" }, { ...cfg, optimizeQuery: false })
    expect(mockSearch).toHaveBeenCalledWith("please tell me about TypeScript", expect.anything())
  })

  it("forwards the user's default search options to the service", async () => {
    mockSearch.mockResolvedValue({ provider: "tavily", answer: null, results: [] })
    await webSearch(
      { query: "hi" },
      { ...cfg, searchOptions: { searchType: "news", includeAnswer: true } as never }
    )
    expect(mockSearch).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ searchType: "news", includeAnswer: true })
    )
  })

  it("serves a cache hit without calling the search service", async () => {
    const cached = {
      provider: "exa",
      answer: "cached answer",
      results: [{ title: "C", url: "https://c.test", content: "c", score: 0.5 }],
    }
    const searchCache = {
      get: jest.fn(() => cached as never),
      set: jest.fn(),
    }
    const out = (await webSearch({ query: "hi" }, { ...cfg, searchCache })) as Record<
      string,
      unknown
    >
    expect(mockSearch).not.toHaveBeenCalled()
    expect(searchCache.set).not.toHaveBeenCalled()
    expect(out.provider).toBe("exa")
    expect(out.answer).toBe("cached answer")
  })

  it("populates the cache on a miss", async () => {
    const response = {
      provider: "tavily",
      answer: null,
      results: [{ title: "T", url: "https://t.test", content: "c", score: 0.9 }],
    }
    mockSearch.mockResolvedValue(response)
    const searchCache = { get: jest.fn(() => null), set: jest.fn() }
    await webSearch({ query: "hi" }, { ...cfg, searchCache })
    expect(searchCache.set).toHaveBeenCalledWith("hi", response, undefined, expect.anything())
  })

  it("filters out blocked domains when source verification is enabled", async () => {
    mockSearch.mockResolvedValue({
      provider: "tavily",
      answer: null,
      results: [
        { title: "Good", url: "https://good.test/a", content: "g", score: 0.8 },
        { title: "Spam", url: "https://spam.test/b", content: "s", score: 0.7 },
      ],
    })
    const out = (await webSearch(
      { query: "hi" },
      {
        ...cfg,
        sourceVerification: {
          enabled: true,
          mode: "moderate",
          minimumCredibilityScore: 0,
          autoFilterLowCredibility: false,
          showVerificationBadges: false,
          trustedDomains: [],
          blockedDomains: ["spam.test"],
          enableCrossValidation: false,
        } as never,
      }
    )) as Record<string, unknown>
    const urls = (out.results as { url: string }[]).map((r) => r.url)
    expect(urls).toEqual(["https://good.test/a"])
  })

  it("drops everything below the minimum credibility when auto-filter is on", async () => {
    mockSearch.mockResolvedValue({
      provider: "tavily",
      answer: null,
      results: [{ title: "X", url: "https://x.test/a", content: "x", score: 0.5 }],
    })
    const out = (await webSearch(
      { query: "hi" },
      {
        ...cfg,
        sourceVerification: {
          enabled: true,
          mode: "strict",
          minimumCredibilityScore: 100000,
          autoFilterLowCredibility: true,
          showVerificationBadges: false,
          trustedDomains: [],
          blockedDomains: [],
          enableCrossValidation: false,
        } as never,
      }
    )) as Record<string, unknown>
    expect((out.results as unknown[]).length).toBe(0)
  })

  it("attaches a credibility badge when showVerificationBadges is on", async () => {
    mockSearch.mockResolvedValue({
      provider: "tavily",
      answer: null,
      results: [{ title: "X", url: "https://x.test/a", content: "x", score: 0.5 }],
    })
    const out = (await webSearch(
      { query: "hi" },
      {
        ...cfg,
        sourceVerification: {
          enabled: true,
          mode: "moderate",
          minimumCredibilityScore: 0,
          autoFilterLowCredibility: false,
          showVerificationBadges: true,
          trustedDomains: [],
          blockedDomains: [],
          enableCrossValidation: false,
        } as never,
      }
    )) as Record<string, unknown>
    const first = (out.results as { credibility?: string }[])[0]
    expect(typeof first.credibility).toBe("string")
  })

  it("surfaces search-service errors", async () => {
    mockSearch.mockRejectedValue(new Error("provider 500"))
    const out = (await webSearch(
      { query: "hi" },
      {
        providerSettings: { tavily: { providerId: "tavily", enabled: true, apiKey: "k" } } as never,
      }
    )) as Record<string, unknown>
    expect(out).toEqual({ ok: false, error: "provider 500" })
  })
})
