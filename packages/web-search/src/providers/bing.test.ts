import {
  searchWithBing,
  searchNewsWithBing,
  searchImagesWithBing,
  testBingConnection,
} from "./bing"

const fetchMock = jest.fn()
jest.mock("../proxy-search-fetch", () => ({
  bingFetch: (...a: unknown[]) => fetchMock(...a),
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

describe("searchWithBing", () => {
  it("requires apiKey", async () => {
    await expect(searchWithBing("q", "")).rejects.toThrow(/required/)
  })

  it("maps web pages, images, and computation answer", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          webPages: {
            totalEstimatedMatches: 100,
            value: [
              {
                id: "1",
                name: "T",
                url: "https://x.com",
                snippet: "s",
                dateLastCrawled: "2024-01-01",
              },
            ],
          },
          images: {
            value: [
              {
                name: "img",
                thumbnailUrl: "thumb",
                contentUrl: "https://img.com",
                hostPageUrl: "https://x.com",
                width: 100,
                height: 200,
              },
            ],
          },
          computation: { expression: "2+2", value: "4" },
        },
      })
    )
    const r = await searchWithBing("q", "k")
    expect(r.provider).toBe("bing")
    expect(r.results).toHaveLength(1)
    expect(r.images).toHaveLength(1)
    expect(r.answer).toBe("2+2 = 4")
    expect(r.totalResults).toBe(100)
  })

  it("forwards query params including freshness", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithBing("q", "k", {
      country: "US",
      language: "en",
      recency: "week",
      responseFilter: ["Webpages"],
    })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("cc=US")
    expect(url).toContain("setLang=en")
    expect(url).toContain("freshness=Week")
    expect(url).toContain("responseFilter=Webpages")
  })

  it.each([
    ["off", "Off"],
    ["moderate", "Moderate"],
    ["strict", "Strict"],
  ] as const)("maps common safe search level %s to Bing %s", async (safeSearch, expected) => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithBing("q", "k", { safeSearch })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain(`safeSearch=${expected}`)
  })

  it("ignores year/any recency", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithBing("q", "k", { recency: "year" })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).not.toContain("freshness=")
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchWithBing("q", "k")).rejects.toThrow(/Bing/)
  })
})

describe("searchNewsWithBing", () => {
  it("requires apiKey", async () => {
    await expect(searchNewsWithBing("q", "")).rejects.toThrow(/required/)
  })

  it("maps news articles", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          value: [
            {
              name: "T",
              url: "https://x.com",
              description: "d",
              datePublished: "2024-01-01",
              provider: [{ name: "Reuters" }],
              image: { thumbnail: { contentUrl: "thumb" } },
            },
          ],
          totalEstimatedMatches: 5,
        },
      })
    )
    const r = await searchNewsWithBing("q", "k", {
      country: "US",
      language: "en",
      recency: "day",
    })
    expect(r.results[0].source).toBe("Reuters")
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchNewsWithBing("q", "k")).rejects.toThrow(/Bing News/)
  })
})

describe("searchImagesWithBing", () => {
  it("requires apiKey", async () => {
    await expect(searchImagesWithBing("q", "")).rejects.toThrow(/required/)
  })

  it("maps images", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          value: [
            {
              name: "img",
              thumbnailUrl: "thumb",
              contentUrl: "https://img.com",
              hostPageUrl: "https://x.com",
            },
          ],
          totalEstimatedMatches: 1,
        },
      })
    )
    const r = await searchImagesWithBing("q", "k", {
      country: "US",
      language: "en",
    })
    expect(r.images).toHaveLength(1)
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchImagesWithBing("q", "k")).rejects.toThrow(/Bing Image/)
  })
})

describe("testBingConnection", () => {
  it("returns true on success", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    expect(await testBingConnection("k")).toBe(true)
  })

  it("returns false on error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"))
    expect(await testBingConnection("k")).toBe(false)
  })
})
