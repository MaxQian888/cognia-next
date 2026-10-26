import {
  searchFetch,
  createSearchProviderFetch,
  braveFetch,
  bingFetch,
  googleFetch,
  googleAIFetch,
  serpApiFetch,
  searchApiFetch,
  exaFetch,
  tavilyFetch,
  perplexityFetch,
  serperFetch,
  ProviderHttpError,
  readErrorDetail,
} from "./proxy-search-fetch"
import {
  resetWebSearchRuntimeAdaptersForTesting,
  setWebSearchRuntimeAdapters,
} from "./runtime-adapters"

function makeFakeResponse(status = 200, body = "ok"): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({}),
  }
}

describe("proxy-search-fetch", () => {
  let fetchMock: jest.Mock
  let originalFetch: typeof globalThis.fetch
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = jest.fn().mockResolvedValue(makeFakeResponse())
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    resetWebSearchRuntimeAdaptersForTesting()
    globalThis.fetch = originalFetch
    Object.defineProperty(process.env, "NODE_ENV", {
      value: originalNodeEnv,
      configurable: true,
    })
  })

  describe("searchFetch", () => {
    it("delegates to native fetch", async () => {
      const resp = (await searchFetch("https://example.com", {
        method: "GET",
      })) as { status: number }
      expect(resp.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledWith("https://example.com", { method: "GET" })
    })

    it("refuses a provider body declared larger than the shared ceiling", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response("{}", { headers: { "content-length": String(64 * 1024 * 1024) } })
      )
      await expect(searchFetch("https://example.com")).rejects.toThrow(/ceiling/)
    })
  })

  describe("createSearchProviderFetch", () => {
    it("returns provider fetch that forwards request and resolves response", async () => {
      const fn = createSearchProviderFetch("Test")
      const resp = (await fn("https://example.com")) as { status: number }
      expect(resp.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledWith("https://example.com", undefined)
    })

    it("forwards init args", async () => {
      const fn = createSearchProviderFetch("Test")
      await fn("https://example.com", { method: "POST", body: "x" })
      expect(fetchMock).toHaveBeenCalledWith("https://example.com", {
        method: "POST",
        body: "x",
      })
    })

    it("logs error and rethrows on failure", async () => {
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
      fetchMock.mockRejectedValueOnce(new Error("network down"))
      const fn = createSearchProviderFetch("Test")
      await expect(fn("https://example.com")).rejects.toThrow("network down")
      expect(errorSpy).toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it("handles URL object input", async () => {
      const fn = createSearchProviderFetch("Test")
      await fn(new URL("https://example.com/path"))
      expect(fetchMock).toHaveBeenCalled()
    })

    it("handles object-with-url input", async () => {
      const fn = createSearchProviderFetch("Test")
      await fn({ url: "https://example.com" } as unknown as RequestInfo)
      expect(fetchMock).toHaveBeenCalled()
    })
  })

  describe("pre-configured provider fetches", () => {
    it.each([
      ["braveFetch", braveFetch],
      ["bingFetch", bingFetch],
      ["googleFetch", googleFetch],
      ["googleAIFetch", googleAIFetch],
      ["serpApiFetch", serpApiFetch],
      ["searchApiFetch", searchApiFetch],
      ["exaFetch", exaFetch],
      ["tavilyFetch", tavilyFetch],
      ["perplexityFetch", perplexityFetch],
      ["serperFetch", serperFetch],
    ])("%s is a callable function that delegates to fetch", async (_name, fn) => {
      const resp = (await fn("https://example.com")) as { status: number }
      expect(resp.status).toBe(200)
      expect(fetchMock).toHaveBeenCalled()
    })
  })

  describe("host-installed transport", () => {
    it("sends provider traffic through the installed proxy fetch instead of bare fetch", async () => {
      const proxied = jest.fn().mockResolvedValue(makeFakeResponse(200, "proxied"))
      setWebSearchRuntimeAdapters({ proxyFetch: proxied as unknown as typeof globalThis.fetch })

      await braveFetch("https://api.search.brave.com/res/v1/web/search", { method: "GET" })

      expect(proxied).toHaveBeenCalledWith("https://api.search.brave.com/res/v1/web/search", {
        method: "GET",
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

describe("ProviderHttpError", () => {
  it("carries the status and keeps the legacy message shape", () => {
    const err = new ProviderHttpError("DeepSeek", 402, "Insufficient Balance", "insufficient")
    expect(err.status).toBe(402)
    expect(err.vendorCode).toBe("insufficient")
    expect(err.message).toBe("DeepSeek API error: 402 - Insufficient Balance")
  })
})

describe("readErrorDetail", () => {
  const res = (body: string) => ({ text: () => Promise.resolve(body) }) as unknown as Response

  it("reads the common vendor error envelopes", async () => {
    expect(await readErrorDetail(res('{"error":{"message":"bad","code":"E1"}}'))).toEqual({
      detail: "bad",
      code: "E1",
    })
    expect(await readErrorDetail(res('{"error":"nope","tag":"T"}'))).toEqual({
      detail: "nope",
      code: "T",
    })
    expect(await readErrorDetail(res('{"message":"m"}'))).toEqual({ detail: "m" })
  })

  it("bounds raw text to one line", async () => {
    const { detail } = await readErrorDetail(res("line1\nline2 " + "x".repeat(500)))
    expect(detail.startsWith("line1 line2")).toBe(true)
    expect(detail.length).toBe(300)
  })
})
