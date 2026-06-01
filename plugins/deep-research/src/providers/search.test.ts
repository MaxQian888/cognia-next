import { makeReadFn, makeSearchFn, stripHtml } from "./search"
import type { FetchLike, FetchResponseLike } from "./search"

function ok(json: unknown, text = ""): FetchResponseLike {
  return { ok: true, status: 200, json: async () => json, text: async () => text }
}
function fail(status = 500): FetchResponseLike {
  return { ok: false, status, json: async () => ({}), text: async () => "" }
}

describe("makeSearchFn (exa)", () => {
  it("maps exa results and sends the api key header", async () => {
    const calls: { url: string; init?: unknown }[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return ok({
        results: [
          {
            title: "A",
            url: "https://a.com",
            text: "alpha",
            score: 0.9,
            publishedDate: "2026-01-01",
          },
          { url: "https://b.com", summary: "beta" },
        ],
      })
    }
    const search = makeSearchFn({ provider: "exa", apiKey: "k", fetchImpl })
    const hits = await search("q", 5)
    expect(hits[0]).toEqual({
      title: "A",
      url: "https://a.com",
      content: "alpha",
      score: 0.9,
      publishedDate: "2026-01-01",
    })
    expect(hits[1]).toMatchObject({ title: "https://b.com", content: "beta", score: 0 })
    expect(calls[0].url).toBe("https://api.exa.ai/search")
    expect((calls[0].init as { headers: Record<string, string> }).headers["x-api-key"]).toBe("k")
  })
})

describe("makeSearchFn (tavily)", () => {
  it("prefers raw_content and maps fields", async () => {
    const fetchImpl: FetchLike = async () =>
      ok({
        results: [
          { title: "T", url: "https://t.com", raw_content: "full", content: "snippet", score: 0.5 },
        ],
      })
    const search = makeSearchFn({ provider: "tavily", apiKey: "k", fetchImpl })
    const hits = await search("q", 3)
    expect(hits[0]).toMatchObject({ title: "T", url: "https://t.com", content: "full" })
  })

  it("falls back to the url for a missing title and leaves publishedDate undefined", async () => {
    const fetchImpl: FetchLike = async () =>
      ok({ results: [{ url: "https://t.com", content: "snip" }] })
    const search = makeSearchFn({ provider: "tavily", apiKey: "k", fetchImpl })
    const hits = await search("q", 3)
    expect(hits[0]).toEqual({
      title: "https://t.com",
      url: "https://t.com",
      content: "snip",
      score: 0,
      publishedDate: undefined,
    })
  })

  it("throws on a non-ok response", async () => {
    const search = makeSearchFn({
      provider: "tavily",
      apiKey: "k",
      fetchImpl: async () => fail(429),
    })
    await expect(search("q", 3)).rejects.toThrow(/429/)
  })
})

describe("resolve", () => {
  it("throws when the api key is missing", () => {
    expect(() =>
      makeSearchFn({ provider: "exa", apiKey: "", fetchImpl: async () => ok({}) })
    ).toThrow(/api key/i)
  })
})

describe("makeReadFn", () => {
  const longSnippet = "x".repeat(500)

  it("tier 1: reuses a long search snippet without any fetch", async () => {
    const fetchImpl = jest.fn<Promise<FetchResponseLike>, [string, unknown?]>()
    const read = makeReadFn({
      provider: "exa",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as FetchLike,
    })
    const out = await read("https://a.com", {
      url: "https://a.com",
      title: "A",
      content: longSnippet,
      score: 1,
    })
    expect(out).toBe(longSnippet.slice(0, 8000))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("tier 2: uses the exa contents endpoint when the snippet is short", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/contents")) return ok({ results: [{ text: "full extracted body" }] })
      return ok({})
    }
    const read = makeReadFn({ provider: "exa", apiKey: "k", fetchImpl })
    const out = await read("https://a.com", {
      url: "https://a.com",
      title: "A",
      content: "short",
      score: 1,
    })
    expect(out).toBe("full extracted body")
  })

  it("tier 2: uses the tavily extract endpoint", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/extract")) return ok({ results: [{ raw_content: "tavily body" }] })
      return ok({})
    }
    const read = makeReadFn({ provider: "tavily", apiKey: "k", fetchImpl })
    expect(await read("https://a.com")).toBe("tavily body")
  })

  it("tier 3: falls back to a direct fetch + html strip", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/contents")) return ok({ results: [] }) // extract empty
      return ok({}, "<html><body><p>Hello <b>world</b></p><script>x()</script></body></html>")
    }
    const read = makeReadFn({ provider: "exa", apiKey: "k", fetchImpl })
    expect(await read("https://a.com")).toBe("Hello world")
  })

  it("tier 3: returns the snippet fallback when the page fetch is not ok", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes("/contents")) return ok({ results: [] })
      return fail(404)
    }
    const read = makeReadFn({ provider: "exa", apiKey: "k", fetchImpl })
    expect(
      await read("https://a.com", { url: "https://a.com", title: "A", content: "snip", score: 1 })
    ).toBe("snip")
  })
})

describe("stripHtml", () => {
  it("removes scripts, styles, tags and decodes basic entities", () => {
    const html = "<style>a{}</style><div>Tom &amp; Jerry &lt;3</div><script>bad()</script>"
    expect(stripHtml(html)).toBe("Tom & Jerry <3")
  })
})
