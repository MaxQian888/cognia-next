import {
  searchWithSearchAPI,
  searchNewsWithSearchAPI,
  searchImagesWithSearchAPI,
  searchScholarWithSearchAPI,
  testSearchAPIConnection,
} from "./searchapi"

const fetchMock = jest.fn()
jest.mock("../proxy-search-fetch", () => ({
  searchApiFetch: (...a: unknown[]) => fetchMock(...a),
}))

function fakeResp(opts: { ok?: boolean; json?: unknown; text?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.ok === false ? 401 : 200,
    json: () => Promise.resolve(opts.json ?? {}),
    text: () => Promise.resolve(opts.text ?? ""),
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  jest.spyOn(console, "error").mockImplementation(() => {})
})

describe("searchWithSearchAPI", () => {
  it("requires apiKey", async () => {
    await expect(searchWithSearchAPI("q", "")).rejects.toThrow(/required/)
  })

  it("maps organic results", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          organic_results: [
            {
              position: 1,
              title: "T",
              link: "https://x.com",
              snippet: "s",
              source: "x",
            },
          ],
          search_information: { total_results: 100 },
        },
      })
    )
    const r = await searchWithSearchAPI("q", "k")
    expect(r.provider).toBe("searchapi")
    expect(r.totalResults).toBe(100)
  })

  it("uses news_results when engine is google_news", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          news_results: [
            {
              position: 1,
              title: "T",
              link: "https://x.com",
              snippet: "s",
              source: "x",
            },
          ],
        },
      })
    )
    const r = await searchWithSearchAPI("q", "k", { engine: "google_news" })
    expect(r.results).toHaveLength(1)
  })

  it("uses image_results when engine is google_images", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          image_results: [
            {
              position: 1,
              title: "img",
              link: "https://page.com",
              thumbnail: "thumb",
              original: "https://img.com",
            },
          ],
        },
      })
    )
    const r = await searchWithSearchAPI("q", "k", { engine: "google_images" })
    expect(r.images).toHaveLength(1)
  })

  it("prefers ai_overview > answer_box.answer > answer_box.snippet", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          ai_overview: { text: "ai" },
          answer_box: { type: "x", answer: "ans", snippet: "snip" },
        },
      })
    )
    expect((await searchWithSearchAPI("q", "k")).answer).toBe("ai")

    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: { answer_box: { type: "x", answer: "ans" } },
      })
    )
    expect((await searchWithSearchAPI("q", "k")).answer).toBe("ans")

    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: { answer_box: { type: "x", snippet: "snip" } },
      })
    )
    expect((await searchWithSearchAPI("q", "k")).answer).toBe("snip")
  })

  it("forwards parameters", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithSearchAPI("q", "k", {
      country: "us",
      language: "en",
      location: "Beijing",
      googleDomain: "google.com",
      recency: "month",
      page: 2,
    })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("gl=us")
    expect(url).toContain("hl=en")
    expect(url).toContain("location=Beijing")
    expect(url).toContain("google_domain=google.com")
    expect(url).toContain("safe=active")
    expect(url).toContain("tbs=qdr%3Am")
    expect(url).toContain("page=2")
  })

  it.each([
    ["off", false],
    ["moderate", true],
    ["strict", true],
  ] as const)("maps common safe search level %s", async (safeSearch, active) => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithSearchAPI("q", "k", { safeSearch })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url.includes("safe=active")).toBe(active)
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchWithSearchAPI("q", "k")).rejects.toThrow(/SearchAPI/)
  })
})

describe("specialty wrappers", () => {
  it("searchNewsWithSearchAPI uses google_news engine", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: { news_results: [] } }))
    await searchNewsWithSearchAPI("q", "k")
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("engine=google_news")
  })

  it("searchImagesWithSearchAPI uses google_images engine", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: { image_results: [] } }))
    await searchImagesWithSearchAPI("q", "k")
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("engine=google_images")
  })

  it("searchScholarWithSearchAPI uses google_scholar engine", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchScholarWithSearchAPI("q", "k")
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("engine=google_scholar")
  })
})

describe("testSearchAPIConnection", () => {
  it("returns true on success", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    expect(await testSearchAPIConnection("k")).toBe(true)
  })

  it("returns false on error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"))
    expect(await testSearchAPIConnection("k")).toBe(false)
  })
})
