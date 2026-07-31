import {
  searchWithSerpAPI,
  searchNewsWithSerpAPI,
  searchImagesWithSerpAPI,
  testSerpAPIConnection,
} from "./serpapi"

const fetchMock = jest.fn()
jest.mock("../proxy-search-fetch", () => ({
  serpApiFetch: (...a: unknown[]) => fetchMock(...a),
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

describe("searchWithSerpAPI", () => {
  it("requires apiKey", async () => {
    await expect(searchWithSerpAPI("q", "")).rejects.toThrow(/required/)
  })

  it("maps organic + news + images and answer", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          organic_results: [
            {
              position: 1,
              title: "T",
              link: "https://x.com",
              snippet: "s",
            },
          ],
          news_results: [
            {
              position: 1,
              title: "N",
              link: "https://n.com",
              snippet: "ns",
            },
          ],
          images_results: [
            {
              position: 1,
              title: "img",
              link: "https://p.com",
              thumbnail: "t",
              original: "https://i.com",
            },
          ],
          answer_box: { type: "x", answer: "ans" },
          search_information: { total_results: 100 },
        },
      })
    )
    const r = await searchWithSerpAPI("q", "k")
    expect(r.provider).toBe("serpapi")
    expect(r.results.length).toBe(2)
    expect(r.images).toHaveLength(1)
    expect(r.answer).toBe("ans")
  })

  it("falls through to answer_box.snippet then knowledge_graph", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: { answer_box: { type: "x", snippet: "s" } } }))
    expect((await searchWithSerpAPI("q", "k")).answer).toBe("s")

    fetchMock.mockResolvedValueOnce(fakeResp({ json: { knowledge_graph: { description: "kg" } } }))
    expect((await searchWithSerpAPI("q", "k")).answer).toBe("kg")
  })

  it("forwards parameters", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithSerpAPI("q", "k", {
      country: "us",
      language: "en",
      location: "Beijing",
      recency: "day",
    })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("gl=us")
    expect(url).toContain("hl=en")
    expect(url).toContain("location=Beijing")
    expect(url).toContain("google_domain=google.com")
    expect(url).toContain("tbs=qdr%3Ad")
  })

  it("does not append google_domain when engine is not google", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithSerpAPI("q", "k", { engine: "bing" })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).not.toContain("google_domain")
  })

  it("appends tbm when provided", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithSerpAPI("q", "k", { tbm: "nws" })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("tbm=nws")
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchWithSerpAPI("q", "k")).rejects.toThrow(/SerpAPI/)
  })
})

describe("searchNewsWithSerpAPI", () => {
  it("uses tbm=nws", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchNewsWithSerpAPI("q", "k")
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("tbm=nws")
  })
})

describe("searchImagesWithSerpAPI", () => {
  it("uses tbm=isch", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchImagesWithSerpAPI("q", "k")
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("tbm=isch")
  })
})

describe("testSerpAPIConnection", () => {
  it("returns true on success", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    expect(await testSerpAPIConnection("k")).toBe(true)
  })

  it("returns false on error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"))
    expect(await testSerpAPIConnection("k")).toBe(false)
  })
})
