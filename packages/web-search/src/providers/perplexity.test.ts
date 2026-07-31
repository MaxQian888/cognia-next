import { searchWithPerplexity, testPerplexityConnection } from "./perplexity"

const fetchMock = jest.fn()
jest.mock("../proxy-search-fetch", () => ({
  perplexityFetch: (...a: unknown[]) => fetchMock(...a),
}))

function fakeResp(opts: { ok?: boolean; json?: unknown; text?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.ok === false ? 500 : 200,
    json: () => Promise.resolve(opts.json ?? {}),
    text: () => Promise.resolve(opts.text ?? ""),
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  jest.spyOn(console, "error").mockImplementation(() => {})
})

describe("searchWithPerplexity", () => {
  it("requires apiKey", async () => {
    await expect(searchWithPerplexity("q", "")).rejects.toThrow(/required/)
  })

  it("maps results with descending score", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          results: [
            { title: "T1", url: "https://a.com", snippet: "s1", date: "2024-01-01" },
            { title: "T2", url: "https://b.com", snippet: "s2", last_updated: "2024-02" },
          ],
        },
      })
    )
    const r = await searchWithPerplexity("q", "k")
    expect(r.provider).toBe("perplexity")
    expect(r.results[0].score).toBeGreaterThan(r.results[1].score)
    expect(r.results[1].publishedDate).toBe("2024-02")
  })

  it("throws when both include and exclude domains are set", async () => {
    await expect(
      searchWithPerplexity("q", "k", {
        includeDomains: ["a"],
        excludeDomains: ["b"],
      })
    ).rejects.toThrow(/mixing/)
  })

  it("forwards include domains and country filter", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: { results: [] } }))
    await searchWithPerplexity("q", "k", {
      includeDomains: ["a.com", "b.com"],
      country: "us",
      language: "en",
      recency: "week",
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.search_domain_filter).toEqual(["a.com", "b.com"])
    expect(body.country).toBe("us")
    expect(body.search_language_filter).toEqual(["en"])
    expect(body.search_recency_filter).toBe("week")
  })

  it("prefixes excludeDomains with -", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: { results: [] } }))
    await searchWithPerplexity("q", "k", {
      excludeDomains: ["bad.com", "-already.com"],
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.search_domain_filter).toEqual(["-bad.com", "-already.com"])
  })

  it("ignores 'any' recency", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: { results: [] } }))
    await searchWithPerplexity("q", "k", { recency: "any" })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.search_recency_filter).toBeUndefined()
  })

  it("forwards date filters", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: { results: [] } }))
    await searchWithPerplexity("q", "k", {
      searchAfterDate: "2024-01-01",
      searchBeforeDate: "2024-12-31",
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.search_after_date_filter).toBe("2024-01-01")
    expect(body.search_before_date_filter).toBe("2024-12-31")
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchWithPerplexity("q", "k")).rejects.toThrow(/Perplexity/)
  })
})

describe("testPerplexityConnection", () => {
  it("returns true on success", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: { results: [] } }))
    expect(await testPerplexityConnection("k")).toBe(true)
  })

  it("returns false on error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"))
    expect(await testPerplexityConnection("k")).toBe(false)
  })
})
