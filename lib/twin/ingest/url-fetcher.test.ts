/**
 * Coverage for the URL fetcher used by the source uploader's "import from
 * URL" path. We stub the global `fetch` since the function uses it on
 * web — Tauri-mode plugin-http is exercised by E2E tests, not units.
 */

import { fetchUrlAsRawSource, pickFormatForUrl } from "./url-fetcher"

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
})

function mockFetch(text: string, headers: Record<string, string>, status = 200): jest.Mock {
  const mock = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(headers),
    text: async () => text,
  }))
  global.fetch = mock as unknown as typeof global.fetch
  return mock
}

describe("fetchUrlAsRawSource", () => {
  it("returns title + content for an HTML page", async () => {
    mockFetch("<html><head><title>Example domain</title></head><body>hi</body></html>", {
      "content-type": "text/html; charset=utf-8",
    })
    const result = await fetchUrlAsRawSource("https://example.com/")
    expect(result.title).toBe("Example domain")
    expect(result.contentType).toContain("text/html")
    expect(result.text).toContain("Example domain")
  })

  it("falls back to the URL pathname when no <title> is present", async () => {
    mockFetch("# Hello", { "content-type": "text/markdown" })
    const result = await fetchUrlAsRawSource("https://docs.example.com/foo/bar.md")
    expect(result.title).toBe("bar.md")
  })

  it("uses the hostname when the URL has no path", async () => {
    mockFetch("plain", { "content-type": "text/plain" })
    const result = await fetchUrlAsRawSource("https://example.com")
    expect(result.title).toBe("example.com")
  })

  it("throws on a non-2xx response", async () => {
    mockFetch("not found", { "content-type": "text/plain" }, 404)
    await expect(fetchUrlAsRawSource("https://example.com/missing")).rejects.toThrow(/404/)
  })

  it("rejects a private/loopback URL (SSRF guard) without fetching", async () => {
    const mock = mockFetch("secret", { "content-type": "text/plain" })
    await expect(fetchUrlAsRawSource("http://169.254.169.254/latest/")).rejects.toThrow(
      /private\/loopback/i
    )
    expect(mock).not.toHaveBeenCalled()
  })

  it("allows a private URL when allowPrivateHosts is set", async () => {
    mockFetch("<html><title>Local</title></html>", { "content-type": "text/html" })
    const result = await fetchUrlAsRawSource("http://localhost:8080/", { allowPrivateHosts: true })
    expect(result.title).toBe("Local")
  })
})

describe("pickFormatForUrl", () => {
  it("returns html for html content-types", () => {
    expect(pickFormatForUrl("text/html")).toBe("html")
    expect(pickFormatForUrl("text/html; charset=utf-8")).toBe("html")
    expect(pickFormatForUrl("application/xhtml+xml")).toBe("html")
  })

  it("returns markdown for non-html content-types", () => {
    expect(pickFormatForUrl("text/plain")).toBe("markdown")
    expect(pickFormatForUrl("text/markdown")).toBe("markdown")
    expect(pickFormatForUrl("application/json")).toBe("markdown")
  })
})
