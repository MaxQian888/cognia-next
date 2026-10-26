import {
  fetchWithTinyFish,
  searchWithTinyFish,
  testTinyFishConnection,
  TINYFISH_FETCH_URL,
  TINYFISH_SEARCH_URL,
} from "./tinyfish"

const fetchMock = jest.fn()

jest.mock("../proxy-search-fetch", () => ({
  ...jest.requireActual("../proxy-search-fetch"),
  tinyfishFetch: (...args: unknown[]) => fetchMock(...args),
}))

function resp(opts: { ok?: boolean; status?: number; json?: unknown }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: () => Promise.resolve(opts.json ?? {}),
    text: () => Promise.resolve(JSON.stringify(opts.json ?? {})),
  }
}

beforeEach(() => fetchMock.mockReset())

describe("searchWithTinyFish", () => {
  it("sends query parameters with X-API-Key and slices to maxResults", async () => {
    fetchMock.mockResolvedValueOnce(
      resp({
        json: {
          results: [
            { position: 1, title: "A", url: "https://a.example", snippet: "a", site_name: "A" },
            { position: 2, title: "B", url: "https://b.example", snippet: "b", date: "2026-10-01" },
          ],
        },
      })
    )
    const r = await searchWithTinyFish("q", "tf-key", {
      maxResults: 1,
      searchType: "news",
      recency: "day",
      language: "zh",
      includeDomains: ["a.example", "c.example"],
    })
    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname.replace(/\/$/, "")).toBe(TINYFISH_SEARCH_URL)
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      query: "q",
      domain_type: "news",
      language: "zh",
      include_domains: "a.example,c.example",
      recency_minutes: "1440",
    })
    expect(init.headers["X-API-Key"]).toBe("tf-key")
    expect(r.results).toEqual([
      { title: "A", url: "https://a.example", content: "a", score: 1, source: "A" },
    ])
  })

  it("uses research_paper for academic and omits minute recency there", async () => {
    fetchMock.mockResolvedValueOnce(resp({ json: { results: [] } }))
    await searchWithTinyFish("q", "k", { searchType: "academic", recency: "year" })
    const params = new URL(fetchMock.mock.calls[0][0]).searchParams
    expect(params.get("domain_type")).toBe("research_paper")
    expect(params.get("recency_minutes")).toBeNull()
  })

  it("surfaces 402 INSUFFICIENT_CREDITS as a typed error", async () => {
    fetchMock.mockResolvedValueOnce(
      resp({
        ok: false,
        status: 402,
        json: { error: { code: "INSUFFICIENT_CREDITS", message: "no" } },
      })
    )
    await expect(searchWithTinyFish("q", "k")).rejects.toMatchObject({
      status: 402,
      vendorCode: "INSUFFICIENT_CREDITS",
    })
  })
})

describe("fetchWithTinyFish", () => {
  it("reads one URL as markdown", async () => {
    fetchMock.mockResolvedValueOnce(
      resp({
        json: { results: [{ url: "u", title: "T", text: "# Body", final_url: "u2" }], errors: [] },
      })
    )
    expect(await fetchWithTinyFish("u", "k", { perUrlTimeoutMs: 999_999 })).toEqual({
      ok: true,
      markdown: "# Body",
      title: "T",
      finalUrl: "u2",
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(TINYFISH_FETCH_URL)
    expect(JSON.parse(init.body)).toEqual({
      urls: ["u"],
      format: "markdown",
      per_url_timeout_ms: 110_000,
    })
  })

  it("maps a per-URL error under HTTP 200 to a failure", async () => {
    fetchMock.mockResolvedValueOnce(
      resp({ json: { results: [], errors: [{ url: "u", error: "bot_blocked" }] } })
    )
    expect(await fetchWithTinyFish("u", "k")).toEqual({
      ok: false,
      error: { url: "u", error: "bot_blocked" },
    })
  })

  it("never treats empty text as success", async () => {
    fetchMock.mockResolvedValueOnce(
      resp({ json: { results: [{ url: "u", text: "  " }], errors: [] } })
    )
    expect(await fetchWithTinyFish("u", "k")).toEqual({
      ok: false,
      error: { url: "u", error: "empty_content" },
    })
  })
})

describe("testTinyFishConnection", () => {
  it("reports failure without throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("net"))
    expect(await testTinyFishConnection("k")).toBe(false)
  })
})
