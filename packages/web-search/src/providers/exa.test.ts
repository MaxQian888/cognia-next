import {
  searchWithExa,
  findSimilarWithExa,
  getContentsWithExa,
  readWithExa,
  testExaConnection,
} from "./exa"

const exaFetchMock = jest.fn()
jest.mock("../proxy-search-fetch", () => ({
  ...jest.requireActual("../proxy-search-fetch"),
  exaFetch: (...a: unknown[]) => exaFetchMock(...a),
}))

function fakeResp(opts: { ok?: boolean; status?: number; json?: unknown; text?: string }) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: () => Promise.resolve(opts.json ?? {}),
    text: () => Promise.resolve(opts.text ?? ""),
  }
}

beforeEach(() => {
  exaFetchMock.mockReset()
  jest.spyOn(console, "error").mockImplementation(() => {})
})

describe("searchWithExa", () => {
  it("requires apiKey", async () => {
    await expect(searchWithExa("q", "")).rejects.toThrow(/required/)
  })

  it("returns mapped results", async () => {
    exaFetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          results: [
            {
              title: "T",
              url: "https://x.com",
              id: "1",
              score: 0.9,
              text: "body",
              publishedDate: "2024",
              author: "A",
            },
          ],
        },
      })
    )
    const r = await searchWithExa("q", "k")
    expect(r.provider).toBe("exa")
    expect(r.results[0].source).toBe("A")
  })

  it("prefers summary over highlights and text", async () => {
    exaFetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          results: [
            {
              title: "T",
              url: "https://x.com",
              id: "1",
              text: "body",
              highlights: ["h1", "h2"],
              summary: "S",
            },
          ],
        },
      })
    )
    const r = await searchWithExa("q", "k")
    expect(r.results[0].content).toBe("S")
  })

  it("uses highlights when no summary", async () => {
    exaFetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          results: [
            {
              title: "T",
              url: "https://x.com",
              id: "1",
              highlights: ["h1", "h2"],
            },
          ],
        },
      })
    )
    const r = await searchWithExa("q", "k")
    expect(r.results[0].content).toBe("h1 ... h2")
  })

  it("forwards filter options", async () => {
    exaFetchMock.mockResolvedValueOnce(fakeResp({ json: { results: [] } }))
    await searchWithExa("q", "k", {
      includeDomains: ["a.com"],
      excludeDomains: ["b.com"],
      includeText: ["foo"],
      excludeText: ["bar"],
      startPublishedDate: "2024-01-01",
      endPublishedDate: "2024-12-31",
      contents: { text: true },
    })
    const body = JSON.parse(exaFetchMock.mock.calls[0][1].body)
    expect(body.includeDomains).toEqual(["a.com"])
    expect(body.excludeDomains).toEqual(["b.com"])
    expect(body.includeText).toEqual(["foo"])
    expect(body.excludeText).toEqual(["bar"])
    expect(body.startPublishedDate).toBe("2024-01-01")
    expect(body.endPublishedDate).toBe("2024-12-31")
    expect(body.contents).toEqual({ text: true })
  })

  it("throws on non-ok response", async () => {
    exaFetchMock.mockResolvedValueOnce(fakeResp({ ok: false, status: 401, text: "bad" }))
    await expect(searchWithExa("q", "k")).rejects.toThrow(/Exa/)
  })
})

describe("findSimilarWithExa", () => {
  it("requires apiKey", async () => {
    await expect(findSimilarWithExa("https://x", "")).rejects.toThrow(/required/)
  })

  it("returns mapped results", async () => {
    exaFetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          results: [{ title: "T", url: "https://x.com", id: "1", text: "B" }],
        },
      })
    )
    const r = await findSimilarWithExa("https://x.com", "k", {
      includeDomains: ["a.com"],
      excludeDomains: ["b.com"],
    })
    expect(r.provider).toBe("exa")
    expect(r.query).toMatch(/Similar to/)
  })

  it("throws on non-ok response", async () => {
    exaFetchMock.mockResolvedValueOnce(fakeResp({ ok: false, status: 500, text: "bad" }))
    await expect(findSimilarWithExa("https://x", "k")).rejects.toThrow(/Exa/)
  })
})

describe("getContentsWithExa", () => {
  it("requires apiKey", async () => {
    await expect(getContentsWithExa(["https://x"], "")).rejects.toThrow(/required/)
  })

  it("returns mapped contents", async () => {
    exaFetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          results: [{ title: "T", url: "https://x.com", id: "1", text: "B" }],
        },
      })
    )
    const r = await getContentsWithExa(["https://x.com"], "k", { text: true })
    expect(r).toHaveLength(1)
  })

  it("falls back to summary content", async () => {
    exaFetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          results: [{ title: "T", url: "https://x.com", id: "1", summary: "S" }],
        },
      })
    )
    const r = await getContentsWithExa(["https://x.com"], "k")
    expect(r[0].content).toBe("S")
  })

  it("throws on non-ok response", async () => {
    exaFetchMock.mockResolvedValueOnce(fakeResp({ ok: false, status: 500, text: "bad" }))
    await expect(getContentsWithExa(["https://x"], "k")).rejects.toThrow(/Exa/)
  })
})

describe("testExaConnection", () => {
  it("returns true on success", async () => {
    exaFetchMock.mockResolvedValueOnce(fakeResp({ json: { results: [] } }))
    expect(await testExaConnection("k")).toBe(true)
  })

  it("returns false on error", async () => {
    exaFetchMock.mockRejectedValueOnce(new Error("network"))
    expect(await testExaConnection("k")).toBe(false)
  })
})

describe("readWithExa", () => {
  it("maps a per-URL status error under HTTP 200 to a failure", async () => {
    exaFetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          results: [],
          statuses: [
            { id: "u", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
          ],
        },
      })
    )
    expect(await readWithExa("u", "k")).toEqual({
      ok: false,
      tag: "CRAWL_NOT_FOUND",
      httpStatusCode: 404,
    })
  })

  it("returns the page text on success and forwards the signal", async () => {
    exaFetchMock.mockResolvedValueOnce(
      fakeResp({
        json: {
          results: [{ url: "u", title: "T", text: "body" }],
          statuses: [{ id: "u", status: "success" }],
        },
      })
    )
    const c = new AbortController()
    expect(await readWithExa("u", "k", { signal: c.signal, livecrawlTimeoutMs: 20_000 })).toEqual({
      ok: true,
      text: "body",
      title: "T",
    })
    const init = exaFetchMock.mock.calls[0][1]
    expect(init.signal).toBe(c.signal)
    expect(JSON.parse(init.body)).toEqual({ urls: ["u"], text: true, livecrawlTimeout: 20_000 })
  })

  it("throws a typed error for a request-level failure", async () => {
    exaFetchMock.mockResolvedValueOnce(
      fakeResp({ ok: false, status: 402, text: '{"error":"no credits"}' })
    )
    await expect(readWithExa("u", "k")).rejects.toMatchObject({ status: 402 })
  })
})

describe("searchWithExa category", () => {
  it("forwards a category for specialized search", async () => {
    exaFetchMock.mockResolvedValueOnce(fakeResp({ json: { results: [] } }))
    await searchWithExa("q", "k", { category: "news" })
    expect(JSON.parse(exaFetchMock.mock.calls[0][1].body).category).toBe("news")
  })
})
