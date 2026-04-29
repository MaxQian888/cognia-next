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
} from "./proxy-search-fetch"

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
})
