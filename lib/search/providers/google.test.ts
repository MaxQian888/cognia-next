import { searchWithGoogle, searchImagesWithGoogle, testGoogleConnection } from "./google"

const fetchMock = jest.fn()
jest.mock("../proxy-search-fetch", () => ({
  googleFetch: (...a: unknown[]) => fetchMock(...a),
}))

function fakeResp(opts: { ok?: boolean; json?: unknown; statusText?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.ok === false ? 500 : 200,
    statusText: opts.statusText ?? "",
    json: () => Promise.resolve(opts.json ?? {}),
    text: () => Promise.resolve(""),
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  jest.spyOn(console, "error").mockImplementation(() => {})
})

describe("searchWithGoogle", () => {
  it("requires apiKey and cx", async () => {
    await expect(searchWithGoogle("q", "")).rejects.toThrow(/Google API key/)
    await expect(searchWithGoogle("q", "k")).rejects.toThrow(/cx/)
  })

  it("maps web items with publishedDate fallback chain", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          items: [
            {
              kind: "k",
              title: "T",
              link: "https://x.com",
              displayLink: "x.com",
              snippet: "s",
              pagemap: {
                cse_thumbnail: [{ src: "thumb1", width: "100", height: "100" }],
                article: [{ datePublished: "2024-01-01" }],
              },
            },
            {
              kind: "k",
              title: "T2",
              link: "https://y.com",
              displayLink: "y.com",
              snippet: "s2",
              pagemap: {
                metatags: [{ "article:published_time": "2024-02" }],
              },
            },
          ],
          searchInformation: { totalResults: "100", searchTime: 0.1 },
          queries: { request: [] },
        },
      })
    )
    const r = await searchWithGoogle("q", "k", { cx: "abc" })
    expect(r.provider).toBe("google")
    expect(r.results).toHaveLength(2)
    expect(r.results[0].publishedDate).toBe("2024-01-01")
    expect(r.results[1].publishedDate).toBe("2024-02")
  })

  it("returns images when googleSearchType is image", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          items: [
            {
              kind: "k",
              title: "img",
              link: "https://img.com",
              displayLink: "img.com",
              snippet: "",
              image: {
                contextLink: "x",
                height: 100,
                width: 100,
                byteSize: 1,
                thumbnailLink: "thumb",
                thumbnailHeight: 50,
                thumbnailWidth: 50,
              },
            },
          ],
          searchInformation: { totalResults: "1", searchTime: 0.1 },
          queries: { request: [] },
        },
      })
    )
    const r = await searchWithGoogle("q", "k", {
      cx: "abc",
      googleSearchType: "image",
    })
    expect(r.images).toHaveLength(1)
    expect(r.results).toHaveLength(0)
  })

  it("forwards filters and date restrict", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          searchInformation: { totalResults: "0", searchTime: 0.1 },
          queries: { request: [] },
        },
      })
    )
    await searchWithGoogle("q", "k", {
      cx: "abc",
      country: "us",
      language: "en",
      recency: "month",
      siteSearch: "example.com",
      siteSearchFilter: "i",
      exactTerms: "react",
      excludeTerms: "vue",
      fileType: "pdf",
    })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("gl=us")
    expect(url).toContain("cr=countryUS")
    expect(url).toContain("lr=lang_en")
    expect(url).toContain("dateRestrict=m1")
    expect(url).toContain("siteSearch=example.com")
    expect(url).toContain("siteSearchFilter=i")
    expect(url).toContain("exactTerms=react")
    expect(url).toContain("excludeTerms=vue")
    expect(url).toContain("fileType=pdf")
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        ok: false,
        statusText: "bad",
        json: { error: { message: "quota" } },
      })
    )
    await expect(searchWithGoogle("q", "k", { cx: "abc" })).rejects.toThrow(/Google/)
  })
})

describe("searchImagesWithGoogle", () => {
  it("delegates to image search", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          items: [],
          searchInformation: { totalResults: "0", searchTime: 0.1 },
          queries: { request: [] },
        },
      })
    )
    const r = await searchImagesWithGoogle("q", "k", { cx: "abc" })
    expect(r.provider).toBe("google")
  })
})

describe("testGoogleConnection", () => {
  it("returns true on success", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          searchInformation: { totalResults: "0", searchTime: 0.1 },
          queries: { request: [] },
        },
      })
    )
    expect(await testGoogleConnection("k", "abc")).toBe(true)
  })

  it("returns false on error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"))
    expect(await testGoogleConnection("k", "abc")).toBe(false)
  })
})
