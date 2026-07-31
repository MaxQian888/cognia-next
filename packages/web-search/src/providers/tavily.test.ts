import {
  searchWithTavily,
  getAnswerFromTavily,
  extractContentWithTavily,
  testTavilyConnection,
} from "./tavily"

const tavilyFetchMock = jest.fn()

jest.mock("../proxy-search-fetch", () => ({
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
    await expect(searchWithTavily("q", "k")).rejects.toThrow(/Tavily/)
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
