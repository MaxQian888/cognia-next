import {
  searchWithSerper,
  searchNewsWithSerper,
  searchImagesWithSerper,
  searchVideosWithSerper,
  searchScholarWithSerper,
  testSerperConnection,
} from "./serper"

const fetchMock = jest.fn()
jest.mock("../proxy-search-fetch", () => ({
  serperFetch: (...a: unknown[]) => fetchMock(...a),
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

describe("searchWithSerper", () => {
  it("requires apiKey", async () => {
    await expect(searchWithSerper("q", "")).rejects.toThrow(/required/)
  })

  it("maps organic results and answerBox", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          organic: [
            {
              title: "T",
              link: "https://x.com",
              snippet: "s",
              position: 1,
              date: "2024-01-01",
              source: "x.com",
            },
          ],
          answerBox: { answer: "42" },
        },
      })
    )
    const r = await searchWithSerper("q", "k")
    expect(r.provider).toBe("serper")
    expect(r.answer).toBe("42")
  })

  it("falls back to answerBox.snippet, then knowledgeGraph", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: { organic: [], answerBox: { snippet: "a" } },
      })
    )
    expect((await searchWithSerper("q", "k")).answer).toBe("a")

    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: { organic: [], knowledgeGraph: { description: "kg" } },
      })
    )
    expect((await searchWithSerper("q", "k")).answer).toBe("kg")
  })

  it("forwards parameters", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithSerper("q", "k", {
      country: "us",
      language: "en",
      recency: "week",
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.gl).toBe("us")
    expect(body.hl).toBe("en")
    expect(body.tbs).toBe("qdr:w")
  })

  it("ignores 'any' recency", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithSerper("q", "k", { recency: "any" })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tbs).toBeUndefined()
  })

  it("clamps maxResults to [1, 100]", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    await searchWithSerper("q", "k", { maxResults: 1000 })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.num).toBe(100)
  })

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchWithSerper("q", "k")).rejects.toThrow(/Serper/)
  })
})

describe("searchNewsWithSerper", () => {
  it("maps news results", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          news: [{ title: "T", link: "https://x.com", snippet: "s", source: "x" }],
        },
      })
    )
    const r = await searchNewsWithSerper("q", "k")
    expect(r.results).toHaveLength(1)
  })

  it("throws on error", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchNewsWithSerper("q", "k")).rejects.toThrow(/Serper news/)
  })
})

describe("searchImagesWithSerper", () => {
  it("maps images and skips empty urls", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          images: [{ imageUrl: "https://img.com", title: "img" }, { imageUrl: "" }],
        },
      })
    )
    const r = await searchImagesWithSerper("q", "k")
    expect(r.images).toHaveLength(1)
  })

  it("throws on error", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchImagesWithSerper("q", "k")).rejects.toThrow(/Serper image/)
  })
})

describe("searchVideosWithSerper", () => {
  it("maps video results", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          videos: [{ title: "v", link: "https://v.com", snippet: "x" }],
        },
      })
    )
    const r = await searchVideosWithSerper("q", "k")
    expect(r.results).toHaveLength(1)
  })

  it("throws on error", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchVideosWithSerper("q", "k")).rejects.toThrow(/Serper video/)
  })
})

describe("searchScholarWithSerper", () => {
  it("maps scholar results", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          organic: [{ title: "T", link: "https://s.com", snippet: "x" }],
          answerBox: { answer: "ans" },
        },
      })
    )
    const r = await searchScholarWithSerper("q", "k")
    expect(r.answer).toBe("ans")
  })

  it("throws on error", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ ok: false, text: "bad" }))
    await expect(searchScholarWithSerper("q", "k")).rejects.toThrow(/Serper scholar/)
  })
})

describe("testSerperConnection", () => {
  it("returns true on success", async () => {
    fetchMock.mockResolvedValueOnce(fakeResp({ json: {} }))
    expect(await testSerperConnection("k")).toBe(true)
  })

  it("returns false on error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"))
    expect(await testSerperConnection("k")).toBe(false)
  })
})
