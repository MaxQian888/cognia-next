import {
  searchWithTavily,
  getAnswerFromTavily,
  extractContentWithTavily,
  extractWithTavily,
  testTavilyConnection,
} from "./tavily"

const tavilyFetchMock = jest.fn()

jest.mock("../proxy-search-fetch", () => ({
  ...jest.requireActual("../proxy-search-fetch"),
  tavilyFetch: (...args: unknown[]) => tavilyFetchMock(...args),
}))

function makeFakeResponse(opts: { ok?: boolean; status?: number; json?: unknown; text?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: () => Promise.resolve(opts.json ?? {}),
    text: () => Promise.resolve(opts.text ?? ""),
  }
}

beforeEach(() => {
  tavilyFetchMock.mockReset()
  jest.spyOn(console, "error").mockImplementation(() => {})
})

describe("searchWithTavily", () => {
  it("requires apiKey", async () => {
    await expect(searchWithTavily("q", "")).rejects.toThrow(/required/)
  })

  it("returns mapped results", async () => {
    tavilyFetchMock.mockResolvedValueOnce(
      makeFakeResponse({
        json: {
          query: "q",
          answer: "summary",
          results: [
            {
              title: "T",
              url: "https://example.com",
              content: "C",
              score: 0.5,
              published_date: "2024-01-01",
            },
          ],
        },
      })
    )
    const r = await searchWithTavily("q", "tvly-1234567890")
    expect(r.provider).toBe("tavily")
    expect(r.answer).toBe("summary")
    expect(r.results).toHaveLength(1)
    expect(r.results[0]).toMatchObject({
      title: "T",
      url: "https://example.com",
      publishedDate: "2024-01-01",
    })
  })

  it("maps deep depth to advanced", async () => {
    tavilyFetchMock.mockResolvedValueOnce(makeFakeResponse({ json: { query: "q", results: [] } }))
    await searchWithTavily("q", "k", { searchDepth: "deep" })
    const body = JSON.parse(tavilyFetchMock.mock.calls[0][1].body as string)
    expect(body.search_depth).toBe("advanced")
  })

  it("forwards include/exclude domains", async () => {
    tavilyFetchMock.mockResolvedValueOnce(makeFakeResponse({ json: { query: "q", results: [] } }))
    await searchWithTavily("q", "k", {
      includeDomains: ["a.com"],
      excludeDomains: ["b.com"],
    })
    const body = JSON.parse(tavilyFetchMock.mock.calls[0][1].body as string)
    expect(body.include_domains).toEqual(["a.com"])
    expect(body.exclude_domains).toEqual(["b.com"])
  })

  it("throws on non-ok HTTP", async () => {
    tavilyFetchMock.mockResolvedValueOnce(
      makeFakeResponse({ ok: false, status: 401, text: "bad key" })
    )
    await expect(searchWithTavily("q", "k")).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 401,
    })
  })

  it("authenticates with a Bearer header, never the key in the body", async () => {
    tavilyFetchMock.mockResolvedValueOnce(makeFakeResponse({ json: { query: "q", results: [] } }))
    await searchWithTavily("q", "tvly-secret")
    const init = tavilyFetchMock.mock.calls[0][1]
    expect(init.headers.Authorization).toBe("Bearer tvly-secret")
    expect(JSON.parse(init.body).api_key).toBeUndefined()
  })

  it("maps topic, recency and safe search onto the wire", async () => {
    tavilyFetchMock.mockResolvedValueOnce(makeFakeResponse({ json: { query: "q", results: [] } }))
    await searchWithTavily("q", "k", { topic: "news", recency: "week", safeSearch: "strict" })
    const body = JSON.parse(tavilyFetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ topic: "news", time_range: "week", safe_search: true })
  })

  it("keeps requested raw_content and returns images", async () => {
    tavilyFetchMock.mockResolvedValueOnce(
      makeFakeResponse({
        json: {
          query: "q",
          images: [
            "https://img.example/a.png",
            { url: "https://img.example/b.png", description: "B" },
          ],
          results: [
            { title: "T", url: "https://e.x", content: "c", score: 1, raw_content: "full text" },
          ],
        },
      })
    )
    const r = await searchWithTavily("q", "k", { includeRawContent: "text" })
    expect(r.results[0].rawContent).toBe("full text")
    expect(r.images).toEqual([
      { url: "https://img.example/a.png" },
      { url: "https://img.example/b.png", title: "B" },
    ])
  })

  it("forwards the cancellation signal", async () => {
    tavilyFetchMock.mockResolvedValueOnce(makeFakeResponse({ json: { query: "q", results: [] } }))
    const controller = new AbortController()
    await searchWithTavily("q", "k", { signal: controller.signal })
    expect(tavilyFetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  })

  it("handles empty results array", async () => {
    tavilyFetchMock.mockResolvedValueOnce(makeFakeResponse({ json: { query: "q" } }))
    const r = await searchWithTavily("q", "k")
    expect(r.results).toEqual([])
  })
})

describe("getAnswerFromTavily", () => {
  it("returns the answer when present", async () => {
    tavilyFetchMock.mockResolvedValueOnce(
      makeFakeResponse({ json: { query: "q", answer: "yes", results: [] } })
    )
    expect(await getAnswerFromTavily("q", "k")).toBe("yes")
  })

  it("returns null when no answer", async () => {
    tavilyFetchMock.mockResolvedValueOnce(makeFakeResponse({ json: { query: "q", results: [] } }))
    expect(await getAnswerFromTavily("q", "k")).toBeNull()
  })
})

describe("extractWithTavily", () => {
  it("maps failed_results to a per-URL failure, not empty success", async () => {
    tavilyFetchMock.mockResolvedValueOnce(
      makeFakeResponse({ json: { results: [], failed_results: [{ url: "u", error: "blocked" }] } })
    )
    expect(await extractWithTavily("u", "k")).toEqual({ ok: false, error: "blocked" })
  })

  it("returns markdown content on success", async () => {
    tavilyFetchMock.mockResolvedValueOnce(
      makeFakeResponse({ json: { results: [{ url: "u", raw_content: "# Hi" }] } })
    )
    expect(await extractWithTavily("u", "k")).toEqual({ ok: true, markdown: "# Hi" })
    expect(JSON.parse(tavilyFetchMock.mock.calls[0][1].body)).toMatchObject({
      urls: ["u"],
      format: "markdown",
    })
  })

  it("throws a typed error for a request-level failure", async () => {
    tavilyFetchMock.mockResolvedValueOnce(makeFakeResponse({ ok: false, status: 432, text: "{}" }))
    await expect(extractWithTavily("u", "k")).rejects.toMatchObject({ status: 432 })
  })
})

describe("extractContentWithTavily", () => {
  it("requires apiKey", async () => {
    await expect(extractContentWithTavily("https://x", "")).rejects.toThrow(/required/)
  })

  it("returns raw_content from first result", async () => {
    tavilyFetchMock.mockResolvedValueOnce(
      makeFakeResponse({
        json: {
          results: [{ url: "https://x", raw_content: "long text" }],
        },
      })
    )
    expect(await extractContentWithTavily("https://x", "k")).toBe("long text")
  })

  it("returns empty string when no results", async () => {
    tavilyFetchMock.mockResolvedValueOnce(makeFakeResponse({ json: {} }))
    expect(await extractContentWithTavily("https://x", "k")).toBe("")
  })

  it("throws on non-ok HTTP", async () => {
    tavilyFetchMock.mockResolvedValueOnce(
      makeFakeResponse({ ok: false, status: 500, text: "boom" })
    )
    await expect(extractContentWithTavily("https://x", "k")).rejects.toThrow(/Tavily extract/)
  })
})

describe("testTavilyConnection", () => {
  it("returns true on success", async () => {
    tavilyFetchMock.mockResolvedValueOnce(
      makeFakeResponse({ json: { query: "test", results: [] } })
    )
    expect(await testTavilyConnection("k")).toBe(true)
  })

  it("returns false on error", async () => {
    tavilyFetchMock.mockRejectedValueOnce(new Error("network"))
    expect(await testTavilyConnection("k")).toBe(false)
  })
})
