import {
  composeDeepSeekQuery,
  DEEPSEEK_FETCH_URL,
  DEEPSEEK_SEARCH_URL,
  fetchWithDeepSeek,
  searchWithDeepSeek,
  testDeepSeekConnection,
} from "./deepseek"

const fetchMock = jest.fn()

jest.mock("../proxy-search-fetch", () => ({
  ...jest.requireActual("../proxy-search-fetch"),
  deepseekFetch: (...args: unknown[]) => fetchMock(...args),
}))

function resp(opts: { ok?: boolean; status?: number; json?: unknown; text?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: () => Promise.resolve(opts.json ?? {}),
    text: () => Promise.resolve(opts.text ?? JSON.stringify(opts.json ?? {})),
  }
}

beforeEach(() => fetchMock.mockReset())

describe("composeDeepSeekQuery", () => {
  const now = Date.parse("2026-10-19T00:00:00Z")

  it("maps one include domain, excludes, recency and language onto query operators", () => {
    expect(
      composeDeepSeekQuery(
        "rust async",
        {
          includeDomains: ["docs.rs"],
          excludeDomains: ["spam.io"],
          recency: "week",
          language: "en",
        },
        now
      )
    ).toBe("rust async site:docs.rs -site:spam.io after:2026-10-12 lang:en")
  })

  it("leaves several include domains to the host filter", () => {
    expect(composeDeepSeekQuery("q", { includeDomains: ["a.com", "b.com"] }, now)).toBe("q")
  })

  it("drops operators that would exceed the 128-character bound, never the query", () => {
    const query = "x".repeat(120)
    expect(composeDeepSeekQuery(query, { excludeDomains: ["example.com"] }, now)).toBe(query)
  })
})

describe("searchWithDeepSeek", () => {
  it("rejects an over-long query before any request", async () => {
    await expect(searchWithDeepSeek("x".repeat(129), "k")).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("posts a bounded request with Bearer auth and maps results", async () => {
    fetchMock.mockResolvedValueOnce(
      resp({
        json: {
          results: [
            {
              rerank_score: 0.9,
              title: "T",
              url: "https://a.example",
              snippet: "s",
              content: "full",
              site_name: "A",
              date: "2026-10-01T00:00:00Z",
            },
            { title: "no url" },
          ],
        },
      })
    )
    const controller = new AbortController()
    const r = await searchWithDeepSeek("q", "sk-1", {
      maxResults: 80,
      includeRawContent: "text",
      signal: controller.signal,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(DEEPSEEK_SEARCH_URL)
    expect(init.headers.Authorization).toBe("Bearer sk-1")
    expect(init.signal).toBe(controller.signal)
    expect(JSON.parse(init.body)).toEqual({ query: "q", count: 50, need_content: true })
    expect(r.provider).toBe("deepseek")
    expect(r.results).toEqual([
      {
        title: "T",
        url: "https://a.example",
        content: "s",
        score: 0.9,
        publishedDate: "2026-10-01T00:00:00Z",
        source: "A",
        rawContent: "full",
      },
    ])
  })

  it("surfaces 402 insufficient balance as a typed error", async () => {
    fetchMock.mockResolvedValueOnce(
      resp({
        ok: false,
        status: 402,
        json: { error: { message: "Insufficient Balance", code: "x" } },
      })
    )
    await expect(searchWithDeepSeek("q", "k")).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 402,
    })
  })
})

describe("fetchWithDeepSeek", () => {
  it("reads one URL as markdown", async () => {
    fetchMock.mockResolvedValueOnce(resp({ json: { title: "Page", content: "# Hello" } }))
    expect(await fetchWithDeepSeek("https://a.example", "k")).toEqual({
      title: "Page",
      markdown: "# Hello",
    })
    expect(fetchMock.mock.calls[0][0]).toBe(DEEPSEEK_FETCH_URL)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ url: "https://a.example" })
  })

  it("keeps the vendor's 403 safety refusal status", async () => {
    fetchMock.mockResolvedValueOnce(
      resp({ ok: false, status: 403, json: { error: { message: "refused" } } })
    )
    await expect(fetchWithDeepSeek("https://a.example", "k")).rejects.toMatchObject({ status: 403 })
  })

  it("rejects an over-long URL before any request", async () => {
    await expect(
      fetchWithDeepSeek("https://a.example/" + "x".repeat(8200), "k")
    ).rejects.toMatchObject({
      status: 400,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("testDeepSeekConnection", () => {
  it("reports success and failure", async () => {
    fetchMock.mockResolvedValueOnce(resp({ json: { results: [] } }))
    expect(await testDeepSeekConnection("k")).toBe(true)
    fetchMock.mockResolvedValueOnce(resp({ ok: false, status: 401, json: {} }))
    expect(await testDeepSeekConnection("k")).toBe(false)
  })
})
