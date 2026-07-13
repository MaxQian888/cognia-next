import {
  searchWithBrave,
  searchNewsWithBrave,
  searchImagesWithBrave,
  searchVideosWithBrave,
  testBraveConnection,
} from "./brave"

const fetchMock = jest.fn()
jest.mock("../proxy-search-fetch", () => ({
  braveFetch: (...a: unknown[]) => fetchMock(...a),
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

describe("searchWithBrave", () => {
  it("requires apiKey", async () => {
    await expect(searchWithBrave("q", "")).rejects.toThrow(/required/)
  })

  it("maps web results and infobox answer", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          web: {
            results: [
              {
                title: "T",
                url: "https://x.com",
                description: "d",
                page_age: "2024-01-01",
                meta_url: { hostname: "x.com", favicon: "fav" },
                thumbnail: { src: "thumb" },
              },
            ],
          },
          infobox: {
            description: "short",
            long_desc: "longer",
          },
        },
      })
    )
    const r = await searchWithBrave("q", "k")
    expect(r.provider).toBe("brave")
    expect(r.results[0].source).toBe("x.com")
    expect(r.answer).toBe("longer")
  })

  it("uses short infobox when no long_desc", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          web: { results: [] },
          infobox: { description: "short" },
        },
      })
    )
    const r = await searchWithBrave("q", "k")
    expect(r.answer).toBe("short")
  })

  it("forwards query parameters", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithBrave("q", "k", {
      country: "us",
      language: "en",
      recency: "week",
    })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("country=us")
    expect(url).toContain("search_lang=en")
    expect(url).toContain("freshness=pw")
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchWithBrave("q", "k")).rejects.toThrow(/Brave/)
  })
})

describe("searchNewsWithBrave", () => {
  it("requires apiKey", async () => {
    await expect(searchNewsWithBrave("q", "")).rejects.toThrow(/required/)
  })

  it("maps news results", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          news: {
            results: [
              {
                title: "T",
                url: "https://x.com",
                description: "d",
                age: "1h",
                meta_url: { hostname: "x.com" },
                source: "Reuters",
              },
            ],
          },
        },
      })
    )
    const r = await searchNewsWithBrave("q", "k", {
      country: "us",
      language: "en",
      recency: "day",
    })
    expect(r.results[0].source).toBe("Reuters")
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchNewsWithBrave("q", "k")).rejects.toThrow(/Brave News/)
  })
})

describe("searchImagesWithBrave", () => {
  it("requires apiKey", async () => {
    await expect(searchImagesWithBrave("q", "")).rejects.toThrow(/required/)
  })

  it("maps images using properties.url when available", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          results: [
            {
              title: "img",
              url: "https://page.com",
              source: "x",
              thumbnail: { src: "thumb" },
              properties: { url: "https://img.com", width: 100, height: 100 },
            },
            {
              title: "img2",
              url: "https://page2.com",
              source: "x",
            },
          ],
        },
      })
    )
    const r = await searchImagesWithBrave("q", "k", { country: "us" })
    expect(r.images?.[0].url).toBe("https://img.com")
    expect(r.images?.[1].url).toBe("https://page2.com")
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchImagesWithBrave("q", "k")).rejects.toThrow(/Brave Images/)
  })
})

describe("searchVideosWithBrave", () => {
  it("requires apiKey", async () => {
    await expect(searchVideosWithBrave("q", "")).rejects.toThrow(/required/)
  })

  it("maps video results", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          videos: {
            results: [
              {
                title: "vid",
                url: "https://v.com",
                description: "d",
                age: "1d",
                meta_url: { hostname: "v.com" },
                video: { publisher: "YT" },
              },
            ],
          },
        },
      })
    )
    const r = await searchVideosWithBrave("q", "k", {
      country: "us",
      language: "en",
    })
    expect(r.results[0].source).toBe("YT")
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchVideosWithBrave("q", "k")).rejects.toThrow(/Brave Videos/)
  })
})

describe("testBraveConnection", () => {
  it("returns true on success", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    expect(await testBraveConnection("k")).toBe(true)
  })

  it("returns false on error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"))
    expect(await testBraveConnection("k")).toBe(false)
  })
})
