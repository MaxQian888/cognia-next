import { SEARXNG_ENGINE_PATTERN, searchWithSearXNG, testSearXNGConnection } from "./searxng"

const fetchMock = jest.fn()

jest.mock("../proxy-search-fetch", () => ({
  ...jest.requireActual("../proxy-search-fetch"),
  searxngFetch: (...args: unknown[]) => fetchMock(...args),
}))

function resp(opts: { ok?: boolean; status?: number; json?: unknown; url?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    url: opts.url ?? "",
    json: () => Promise.resolve(opts.json ?? {}),
    text: () => Promise.resolve(JSON.stringify(opts.json ?? {})),
  }
}

beforeEach(() => fetchMock.mockReset())

describe("searchWithSearXNG", () => {
  it("builds the JSON request from canonical options without any key", async () => {
    fetchMock.mockResolvedValueOnce(
      resp({
        json: {
          results: [
            {
              title: "A",
              url: "https://a.example",
              content: "a",
              engine: "duckduckgo",
              publishedDate: "2026-10-01T00:00:00",
            },
            { title: "no url", url: null },
          ],
        },
      })
    )
    const r = await searchWithSearXNG(
      "q",
      { baseUrl: "https://search.example/searx/", engine: "duckduckgo" },
      { language: "en", recency: "month", safeSearch: "strict", maxResults: 5 },
      "news"
    )
    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe("https://search.example/searx/search")
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      q: "q",
      format: "json",
      pageno: "1",
      categories: "news",
      engines: "duckduckgo",
      language: "en",
      time_range: "month",
      safesearch: "2",
    })
    expect(init.redirect).toBe("error")
    expect(init.headers.Authorization).toBeUndefined()
    expect(r.results).toEqual([
      {
        title: "A",
        url: "https://a.example",
        content: "a",
        score: 1,
        publishedDate: "2026-10-01T00:00:00",
        source: "duckduckgo",
      },
    ])
  })

  it("explains a disabled JSON format instead of returning nothing", async () => {
    fetchMock.mockResolvedValueOnce(resp({ ok: false, status: 403 }))
    await expect(searchWithSearXNG("q", { baseUrl: "https://s.example" })).rejects.toThrow(
      /JSON output is disabled/
    )
  })

  it("refuses a private endpoint without an explicit grant, before any request", async () => {
    await expect(
      searchWithSearXNG("q", { baseUrl: "http://127.0.0.1:8888" })
    ).rejects.toMatchObject({
      status: 403,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(resp({ json: { results: [] } }))
    await expect(
      searchWithSearXNG("q", { baseUrl: "http://127.0.0.1:8888", allowPrivateEndpoint: true })
    ).resolves.toMatchObject({ provider: "searxng" })
  })

  it("refuses a response that was redirected to another origin", async () => {
    fetchMock.mockResolvedValueOnce(
      resp({ json: { results: [] }, url: "https://elsewhere.example/search" })
    )
    await expect(searchWithSearXNG("q", { baseUrl: "https://s.example" })).rejects.toThrow(
      /different origin/
    )
  })

  it("rejects malformed engine names", async () => {
    await expect(
      searchWithSearXNG("q", { baseUrl: "https://s.example", engine: "bad;engine" })
    ).rejects.toMatchObject({ status: 400 })
    expect(SEARXNG_ENGINE_PATTERN.test("google news")).toBe(true)
  })

  it("returns image results for image search", async () => {
    fetchMock.mockResolvedValueOnce(
      resp({
        json: {
          results: [
            {
              title: "I",
              url: "https://p.example",
              img_src: "https://p.example/i.jpg",
              thumbnail_src: "https://p.example/t.jpg",
            },
          ],
        },
      })
    )
    const r = await searchWithSearXNG("q", { baseUrl: "https://s.example" }, {}, "images")
    expect(r.images).toEqual([
      { url: "https://p.example/i.jpg", thumbnailUrl: "https://p.example/t.jpg", title: "I" },
    ])
  })
})

describe("testSearXNGConnection", () => {
  it("fails without an endpoint and succeeds against a JSON instance", async () => {
    expect(await testSearXNGConnection({})).toBe(false)
    fetchMock.mockResolvedValueOnce(resp({ json: { results: [] } }))
    expect(await testSearXNGConnection({ baseUrl: "https://s.example" })).toBe(true)
  })
})
