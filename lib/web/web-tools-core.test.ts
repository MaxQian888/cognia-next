import { webFetch, webSearch } from "./web-tools-core"

jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(() => "FORMATTED"),
}))
jest.mock("@/lib/document/parsers/html-parser", () => ({
  parseHTML: jest.fn(async () => ({ text: "readable text", title: "Title" })),
}))
jest.mock("@/lib/search/types", () => ({
  DEFAULT_SEARCH_PROVIDER_SETTINGS: {},
  isProviderConfigured: jest.fn((_id: string, p: { apiKey?: string }) => Boolean(p?.apiKey)),
}))

import { search } from "@/lib/search/search-service"
import { parseHTML } from "@/lib/document/parsers/html-parser"

const mockSearch = search as jest.Mock
const mockParseHTML = parseHTML as jest.Mock

function res(body: string, contentType = "text/html", ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: new Headers({ "content-type": contentType }),
    text: async () => body,
  } as unknown as Response
}

describe("webFetch", () => {
  it("requires a url", async () => {
    expect(await webFetch({ url: "" })).toEqual({ ok: false, error: "url is required" })
  })

  it("returns body + readable text for HTML responses", async () => {
    const fetchImpl = jest.fn(async () => res("<html><body>hi</body></html>"))
    const out = (await webFetch({ url: "https://x.test" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(out.ok).toBe(true)
    expect(out.body).toContain("<html>")
    expect(out.text).toBe("readable text")
    expect(out.title).toBe("Title")
    expect(mockParseHTML).toHaveBeenCalled()
  })

  it("skips extraction in raw mode", async () => {
    mockParseHTML.mockClear()
    const fetchImpl = jest.fn(async () => res("<html>x</html>"))
    const out = (await webFetch({ url: "https://x.test", format: "raw" }, { fetchImpl })) as Record<
      string,
      unknown
    >
    expect(out.text).toBeUndefined()
    expect(mockParseHTML).not.toHaveBeenCalled()
  })

  it("applies a User-Agent header and a byte cap", async () => {
    const fetchImpl = jest.fn(async (_url: string, _init?: RequestInit) =>
      res("abcdefgh", "text/plain")
    )
    const out = (await webFetch(
      { url: "https://x.test", maxBytes: 4 },
      { fetchImpl: fetchImpl as unknown as typeof fetch, userAgent: "Cognia/1" }
    )) as Record<string, unknown>
    expect(out.body).toBe("abcd")
    expect(out.truncated).toBe(true)
    const headers = (fetchImpl.mock.calls[0][1]?.headers ?? {}) as Record<string, string>
    expect(headers["User-Agent"]).toBe("Cognia/1")
  })

  it("returns a structured error when fetch throws", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("network down")
    })
    expect(await webFetch({ url: "https://x.test" }, { fetchImpl })).toEqual({
      ok: false,
      error: "network down",
    })
  })
})

describe("webSearch", () => {
  beforeEach(() => mockSearch.mockReset())

  it("requires a query", async () => {
    expect(await webSearch({ query: "  " })).toEqual({ ok: false, error: "query is required" })
  })

  it("errors when no provider is configured", async () => {
    const out = (await webSearch(
      { query: "hi" },
      { providerSettings: { tavily: { providerId: "tavily", enabled: true } } as never }
    )) as Record<string, unknown>
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/No web search provider/)
  })

  it("returns ranked results from the search service", async () => {
    mockSearch.mockResolvedValue({
      provider: "tavily",
      answer: "the answer",
      results: [{ title: "T", url: "u", content: "c", score: 0.9 }],
    })
    const out = (await webSearch(
      { query: "hi", maxResults: 3 },
      {
        providerSettings: {
          tavily: { providerId: "tavily", enabled: true, apiKey: "k" },
        } as never,
      }
    )) as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(out.provider).toBe("tavily")
    expect(out.formatted).toBe("FORMATTED")
    expect((out.results as unknown[]).length).toBe(1)
    expect(mockSearch).toHaveBeenCalledWith("hi", expect.objectContaining({ maxResults: 3 }))
  })

  it("surfaces search-service errors", async () => {
    mockSearch.mockRejectedValue(new Error("provider 500"))
    const out = (await webSearch(
      { query: "hi" },
      {
        providerSettings: { tavily: { providerId: "tavily", enabled: true, apiKey: "k" } } as never,
      }
    )) as Record<string, unknown>
    expect(out).toEqual({ ok: false, error: "provider 500" })
  })
})
