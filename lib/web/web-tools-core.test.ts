import { webFetch, webSearch, buildFetchExtractor, type WebSearchDeps } from "./web-tools-core"
import { unwrapUntrustedContent } from "./untrusted-content"
import type { SearchResponse } from "@cognia/web-search/types"

const piiDeepMock = jest.fn()

jest.mock("@cognia/redact", () => {
  const actual = jest.requireActual("@cognia/redact")
  return {
    ...actual,
    hasNoLeakingPiiDeep: (...args: unknown[]) => piiDeepMock(...args),
  }
})
jest.mock("@cognia/document/parsers/html-parser", () => ({
  parseHTML: jest.fn(async () => ({ text: "readable text", title: "Title" })),
}))
import { parseHTML } from "@cognia/document/parsers/html-parser"

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
  const actual = jest.requireActual("@cognia/redact") as {
    hasNoLeakingPiiDeep: (...args: unknown[]) => boolean
  }
  piiDeepMock.mockReset().mockImplementation(actual.hasNoLeakingPiiDeep)
  mockParseHTML.mockReset()
  mockParseHTML.mockResolvedValue({ text: "readable text", title: "Title" })
})

describe("webFetch", () => {
  it("requires a url", async () => {
    expect(await webFetch({ url: "" })).toEqual({
      ok: false,
      code: "invalid-arguments",
      error: "url is required",
    })
  })

  it("rejects outbound fetch inputs that contain unredacted PII", async () => {
    const fetchImpl = jest.fn(async () => res("ok", "text/plain"))
    const out = await webFetch(
      { url: "https://x.test", body: "contact alice@example.com" },
      { fetchImpl }
    )
    expect(out).toEqual({
      ok: false,
      code: "blocked",
      error: "web_fetch blocked: outbound request contains sensitive data",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("gates the final headers after injecting the configured user agent", async () => {
    const fetchImpl = jest.fn(async () => res("ok", "text/plain"))
    const out = await webFetch(
      { url: "https://x.test" },
      { fetchImpl, userAgent: "contact alice@example.com" }
    )
    expect(out).toEqual({
      ok: false,
      code: "blocked",
      error: "web_fetch blocked: outbound request contains sensitive data",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("returns extracted text (NOT the raw body) for HTML responses", async () => {
    const fetchImpl = jest.fn(async () => res("<html><body>hi</body></html>"))
    const out = (await webFetch({ url: "https://x.test" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(out.ok).toBe(true)
    // Page text is framed as untrusted for injection safety — once, as a
    // sibling field, so `text` and `title` stay usable verbatim.
    expect(out.text).toContain("readable text")
    expect(out.untrustedNotice).toContain("Untrusted web content")
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
    expect(unwrapUntrustedContent(String(out.body))).toBe("<html>x</html>")
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
    expect(unwrapUntrustedContent(String(out.title))).toBe("JT")
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
    expect(unwrapUntrustedContent(String(out.body))).toBe('{"a":1}')
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
    expect(unwrapUntrustedContent(String(out.body))).toBe("<html></html>")
    expect(out.text).toBeUndefined()
  })

  it("falls back to the raw body when the HTML parser throws", async () => {
    mockParseHTML.mockRejectedValue(new Error("bad html"))
    const fetchImpl = jest.fn(async () => res("<html>oops</html>"))
    const out = (await webFetch({ url: "https://x.test" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(unwrapUntrustedContent(String(out.body))).toBe("<html>oops</html>")
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
    expect(unwrapUntrustedContent(String(out.body))).toBe("abcd")
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
    // The cap applies to `text` directly — the frame is one payload-level
    // `untrustedNotice`, not a banner glued onto each field.
    expect((out.text as string).length).toBe(40 * 1024)
    expect(out.untrustedNotice).toContain("Untrusted web content")
    expect(out.truncated).toBe(true)
  })

  it("respects a preset User-Agent and a maxBytes extract cap for HTML", async () => {
    mockParseHTML.mockResolvedValue({ text: "y".repeat(20), title: undefined })
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) => res("<html>big</html>"))
    const out = (await webFetch(
      { url: "https://x.test", maxBytes: 8, headers: { "User-Agent": "Preset/9" } },
      { fetchImpl: fetchImpl as unknown as typeof fetch, userAgent: "Cognia/1" }
    )) as Record<string, unknown>
    // maxBytes set → extract cap follows it.
    expect((out.text as string).length).toBe(8)
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
    expect(out.untrustedNotice).toContain("Untrusted web content")
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
    // Fell back to extracted text → still framed, once, at payload level.
    expect(out.text).toContain("readable text")
    expect(out.untrustedNotice).toContain("Untrusted web content")
  })

  it("ignores the prompt when no summarizer is available", async () => {
    const fetchImpl = jest.fn(async () => res("<html>full page</html>"))
    const out = (await webFetch(
      { url: "https://x.test", prompt: "what is x?" },
      { fetchImpl }
    )) as Record<string, unknown>
    expect(out.text).toContain("readable text")
  })

  it("frames distilled output once at payload level, leaving text verbatim", async () => {
    const fetchImpl = jest.fn(async () => res("<html>full page</html>"))
    const summarize = jest.fn(async () => "FOCUSED ANSWER")
    const out = (await webFetch(
      { url: "https://x.test", prompt: "what is x?" },
      { fetchImpl, summarize }
    )) as Record<string, unknown>
    // Distillation reduces content but does not make the page trusted; the
    // frame is a sibling field so `text` stays usable verbatim.
    expect(out.text).toBe("FOCUSED ANSWER")
    expect(out.untrustedNotice).toContain("Untrusted web content")
  })

  it("alwaysDistill runs the summarizer with a generic prompt when no prompt is given", async () => {
    const fetchImpl = jest.fn(async () => res("<html>full page</html>"))
    const summarize = jest.fn(async () => "GENERIC SUMMARY")
    const out = (await webFetch(
      { url: "https://x.test" },
      { fetchImpl, summarize, alwaysDistill: true }
    )) as Record<string, unknown>
    expect(out.text).toBe("GENERIC SUMMARY")
    expect(out.untrustedNotice).toContain("Untrusted web content")
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
      code: "execution-failed",
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
    expect(unwrapUntrustedContent(String(out.body))).toBe("rawpngbytes")
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
    expect(unwrapUntrustedContent(String(out.body))).toBe("4567")
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

  it("redacts the extraction question and page before calling a cloud model", async () => {
    const complete = jest.fn(async (_prompt: string) => "ok")
    const extract = buildFetchExtractor({ complete })
    await extract("Email alice@example.com", "Find alice@example.com")
    const [prompt] = complete.mock.calls[0]
    expect(prompt).not.toContain("alice@example.com")
    expect(prompt).toContain("<EMAIL_001>")
  })

  it("fails closed before cloud extraction when redaction leaves sensitive data", async () => {
    piiDeepMock.mockReturnValue(false)
    const complete = jest.fn(async () => "ok")

    await expect(buildFetchExtractor({ complete })("page", "question")).rejects.toThrow(
      "Web extraction blocked"
    )
    expect(complete).not.toHaveBeenCalled()
  })

  it("tolerates a nullish completion", async () => {
    const complete = jest.fn(async () => undefined as unknown as string)
    const extract = buildFetchExtractor({ complete })
    expect(await extract("text", "q")).toBe("")
  })
})

describe("webSearch", () => {
  const executor = (
    response: SearchResponse | Error
  ): jest.MockedFunction<NonNullable<WebSearchDeps["searchExecutor"]>> => {
    const implementation: NonNullable<WebSearchDeps["searchExecutor"]> = async () => {
      if (response instanceof Error) throw response
      return response
    }
    return jest.fn(implementation)
  }

  it("requires a query", async () => {
    expect(await webSearch({ query: "  " })).toEqual({
      ok: false,
      code: "invalid-arguments",
      error: "query is required",
    })
  })

  it("fails closed when the canonical executor is missing", async () => {
    await expect(webSearch({ query: "hi" })).resolves.toEqual({
      ok: false,
      code: "no-search-provider",
      error:
        "No web search provider is configured. Enable one and add its API key in Settings → Search.",
    })
  })

  it("delegates app policy to one configured search executor", async () => {
    const searchExecutor = executor({
      query: "TypeScript",
      provider: "tavily" as const,
      results: [{ title: "T", url: "https://t.test", content: "c", score: 0.9 }],
      responseTime: 1,
    })
    const out = (await webSearch(
      { query: "please tell me about TypeScript", provider: "tavily", maxResults: 3 },
      { searchExecutor }
    )) as Record<string, unknown>

    expect(searchExecutor).toHaveBeenCalledWith("please tell me about TypeScript", {
      provider: "tavily",
      maxResults: 3,
    })
    expect(out).toMatchObject({ ok: true, provider: "tavily" })
  })

  it("returns structured results without a duplicate formatted block", async () => {
    const searchExecutor = executor({
      provider: "tavily",
      query: "hi",
      answer: "the answer",
      results: [{ title: "T", url: "u", content: "c", score: 0.9 }],
      responseTime: 1,
    })
    const out = (await webSearch({ query: "hi", maxResults: 3 }, { searchExecutor })) as Record<
      string,
      unknown
    >
    expect(out.ok).toBe(true)
    expect(out.provider).toBe("tavily")
    // The duplicate markdown re-serialization is gone.
    expect(out.formatted).toBeUndefined()
    expect((out.results as unknown[]).length).toBe(1)
    expect(searchExecutor).toHaveBeenCalledWith("hi", { maxResults: 3 })
  })

  it("truncates long per-result snippets", async () => {
    const searchExecutor = executor({
      provider: "tavily",
      query: "hi",
      answer: undefined,
      results: [{ title: "T", url: "u", content: "z".repeat(500), score: 0.5 }],
      responseTime: 1,
    })
    const out = (await webSearch({ query: "hi" }, { searchExecutor })) as Record<string, unknown>
    const first = (out.results as { content: string }[])[0]
    // The untrusted frame is carried once by the envelope, not repeated on
    // every title and snippet, so the snippet itself is the raw text.
    expect(out.untrustedNotice).toContain("Untrusted web content")
    expect(first.content).not.toContain("Untrusted web content")
    expect(first.content.endsWith("…")).toBe(true)
  })

  it("honors a forced provider + deps.searchMaxResults and keeps publishedDate", async () => {
    const searchExecutor = executor({
      provider: "exa",
      query: "hi",
      answer: undefined,
      results: [
        { title: "T", url: "u", content: "c", score: 0.5, publishedDate: "2026-01-01" },
        { title: "T2", url: "u2", content: "", score: 0.4 },
      ],
      responseTime: 1,
    })
    const out = (await webSearch(
      { query: "hi", provider: "exa" as never },
      { searchExecutor, searchMaxResults: 7 }
    )) as Record<string, unknown>
    expect(searchExecutor).toHaveBeenCalledWith("hi", { provider: "exa", maxResults: 7 })
    const rows = out.results as { publishedDate?: string; content: unknown }[]
    expect(rows[0].publishedDate).toBe("2026-01-01")
    expect(unwrapUntrustedContent(String(rows[1].content))).toBe("")
    expect(out.answer).toBeNull()
  })

  it("forwards the user's default search options to the canonical executor", async () => {
    const searchExecutor = executor({
      provider: "tavily" as const,
      query: "hi",
      answer: undefined,
      results: [],
      responseTime: 1,
    })
    await webSearch(
      { query: "hi" },
      { searchExecutor, searchOptions: { searchType: "news", includeAnswer: true } as never }
    )
    expect(searchExecutor).toHaveBeenCalledWith("hi", {
      searchType: "news",
      includeAnswer: true,
    })
  })

  it("filters out blocked domains when source verification is enabled", async () => {
    const searchExecutor = executor({
      provider: "tavily",
      query: "hi",
      answer: undefined,
      results: [
        { title: "Good", url: "https://good.test/a", content: "g", score: 0.8 },
        { title: "Spam", url: "https://spam.test/b", content: "s", score: 0.7 },
      ],
      responseTime: 1,
    })
    const out = (await webSearch(
      { query: "hi" },
      {
        searchExecutor,
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
    const searchExecutor = executor({
      provider: "tavily",
      query: "hi",
      answer: undefined,
      results: [{ title: "X", url: "https://x.test/a", content: "x", score: 0.5 }],
      responseTime: 1,
    })
    const out = (await webSearch(
      { query: "hi" },
      {
        searchExecutor,
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
    const searchExecutor = executor({
      provider: "tavily",
      query: "hi",
      answer: undefined,
      results: [{ title: "X", url: "https://x.test/a", content: "x", score: 0.5 }],
      responseTime: 1,
    })
    const out = (await webSearch(
      { query: "hi" },
      {
        searchExecutor,
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

  it("surfaces canonical executor errors", async () => {
    const searchExecutor = executor(new Error("provider 500"))
    const out = (await webSearch({ query: "hi" }, { searchExecutor })) as Record<string, unknown>
    expect(out).toEqual({ ok: false, code: "execution-failed", error: "provider 500" })
  })
})
