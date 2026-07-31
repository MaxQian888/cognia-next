import { OpenVsxClient, OpenVsxError, getOpenVsxClient, resetOpenVsxClient } from "./openvsx-client"

jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))
import { proxyFetch } from "@/lib/network/proxy-fetch"
const proxyFetchMock = proxyFetch as jest.Mock

const BASE = "https://open-vsx.org"

/** A minimal but realistic live-shaped search entry. */
function searchEntry(overrides: Record<string, unknown> = {}) {
  return {
    url: `${BASE}/api/esbenp/prettier-vscode`,
    files: {
      download: `${BASE}/api/esbenp/prettier-vscode/12.4.0/file/esbenp.prettier-vscode-12.4.0.vsix`,
      signature: `${BASE}/api/esbenp/prettier-vscode/12.4.0/file/esbenp.prettier-vscode-12.4.0.sigzip`,
      icon: `${BASE}/api/esbenp/prettier-vscode/12.4.0/file/icon.png`,
      sha256: `${BASE}/api/esbenp/prettier-vscode/12.4.0/file/esbenp.prettier-vscode-12.4.0.sha256`,
      publicKey: `${BASE}/api/-/public-key/14ccb407-4e79-41ed-be5a-6d608325c45a`,
    },
    name: "prettier-vscode",
    namespace: "esbenp",
    version: "12.4.0",
    timestamp: "2026-06-01T00:00:00Z",
    verified: true,
    averageRating: 4.35,
    reviewCount: 17,
    downloadCount: 8_222_247,
    displayName: "Prettier - Code formatter",
    description: "Code formatter using prettier",
    deprecated: false,
    ...overrides,
  }
}

function jsonResponse(payload: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: init.headers,
  })
}

/**
 * A `Response` body can only be read once, so a plain `mockResolvedValue`
 * breaks the moment a test expects more than one request. Always mint a fresh
 * Response per call.
 */
function alwaysJson(payload: unknown) {
  return jest.fn(async () => jsonResponse(payload))
}

const EMPTY_SEARCH = { offset: 0, totalSize: 0, extensions: [] }

beforeEach(() => {
  proxyFetchMock.mockReset()
  resetOpenVsxClient()
})

describe("OpenVsxClient — live field names", () => {
  // The published OpenAPI names these `downloads`/`rating`/`ratingCount`, and
  // omits /api/-/search entirely. The live API does not. This test is the
  // tripwire: if someone "corrects" the schema to match the docs, the counts
  // silently become `undefined` everywhere — and this fails instead.
  it("parses_live_field_names_downloadCount_not_downloads", async () => {
    // The spec's names must NOT be read.
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({
        offset: 0,
        totalSize: 1,
        extensions: [
          searchEntry({
            downloadCount: undefined,
            averageRating: undefined,
            reviewCount: undefined,
            // What the (wrong) OpenAPI says we'd get:
            downloads: 8_222_247,
            rating: 4.35,
            ratingCount: 17,
          }),
        ],
      })
    )

    const specShaped = await new OpenVsxClient().searchExtensions({ query: "prettier" })
    expect(specShaped.extensions[0].downloadCount).toBeUndefined()
    expect(specShaped.extensions[0].averageRating).toBeUndefined()
    expect(specShaped.extensions[0].reviewCount).toBeUndefined()
    // The bogus keys are stripped, not smuggled through.
    expect(specShaped.extensions[0]).not.toHaveProperty("downloads")

    // The live names ARE read.
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({ offset: 0, totalSize: 1, extensions: [searchEntry()] })
    )
    const liveShaped = await new OpenVsxClient().searchExtensions({ query: "prettier" })
    expect(liveShaped.extensions[0].downloadCount).toBe(8_222_247)
    expect(liveShaped.extensions[0].averageRating).toBe(4.35)
    expect(liveShaped.extensions[0].reviewCount).toBe(17)
    expect(liveShaped.totalSize).toBe(1)
  })
})

describe("OpenVsxClient — trust guards", () => {
  it("rejects_offsite_download_url", async () => {
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({
        offset: 0,
        totalSize: 1,
        extensions: [
          searchEntry({
            files: {
              ...searchEntry().files,
              download: "https://evil.example.com/api/esbenp/prettier-vscode/x.vsix",
            },
          }),
        ],
      })
    )

    const error = await new OpenVsxClient()
      .searchExtensions({ query: "prettier" })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(OpenVsxError)
    expect((error as OpenVsxError).category).toBe("validation")
    expect((error as OpenVsxError).message).toMatch(/off-site files\.download/)
    expect((error as OpenVsxError).message).toMatch(/evil\.example\.com/)
  })

  it("rejects a download URL that merely embeds the registry host", async () => {
    // `https://open-vsx.org.evil.example.com/...` must not pass a naive
    // substring/startsWith check — the guard compares parsed origins.
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({
        offset: 0,
        totalSize: 1,
        extensions: [
          searchEntry({
            files: {
              ...searchEntry().files,
              download: "https://open-vsx.org.evil.example.com/x.vsix",
            },
          }),
        ],
      })
    )

    await expect(new OpenVsxClient().searchExtensions({})).rejects.toThrow(/off-site/)
  })

  it("rejects an unparseable download URL", async () => {
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({
        offset: 0,
        totalSize: 1,
        extensions: [
          searchEntry({ files: { ...searchEntry().files, download: "not-a-url-at-all" } }),
        ],
      })
    )
    await expect(new OpenVsxClient().searchExtensions({})).rejects.toThrow(
      /malformed files\.download URL/
    )
  })

  it("rejects_extension_with_traversal_in_namespace", async () => {
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({
        offset: 0,
        totalSize: 1,
        extensions: [searchEntry({ namespace: "../../../etc" })],
      })
    )

    const error = await new OpenVsxClient().searchExtensions({}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpenVsxError)
    expect((error as OpenVsxError).category).toBe("validation")
    expect((error as OpenVsxError).message).toMatch(/publisher/)
  })

  it("rejects a traversal in the extension name, and does not escape it", async () => {
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({ offset: 0, totalSize: 1, extensions: [searchEntry({ name: ".." })] })
    )
    // The manifest path escapes `..` to `--`; the registry path must reject.
    await expect(new OpenVsxClient().searchExtensions({})).rejects.toThrow(/name/)
  })

  it("rejects_oversized_response", async () => {
    // Declared length over the cap is refused before the body is read.
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse(
        { offset: 0, totalSize: 0, extensions: [] },
        { headers: { "content-length": String(9 * 1024 * 1024) } }
      )
    )

    const error = await new OpenVsxClient().searchExtensions({}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpenVsxError)
    expect((error as OpenVsxError).category).toBe("validation")
    expect((error as OpenVsxError).message).toMatch(/too large/)
  })

  it("rejects an oversized body that omits content-length", async () => {
    const client = new OpenVsxClient({ maxResponseBytes: 200 })
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ offset: 0, totalSize: 0, extensions: [], pad: "x".repeat(500) })
      )
    )
    await expect(client.searchExtensions({})).rejects.toThrow(/too large/)
  })

  it("rejects a response whose shape does not match the contract", async () => {
    proxyFetchMock.mockResolvedValueOnce(jsonResponse({ totalSize: "many", extensions: [] }))
    const error = await new OpenVsxClient().searchExtensions({}).catch((e: unknown) => e)
    expect((error as OpenVsxError).category).toBe("validation")
    expect((error as OpenVsxError).message).toMatch(/unexpected response shape/)
  })

  it("rejects malformed JSON", async () => {
    proxyFetchMock.mockResolvedValueOnce(new Response("<html>nope</html>"))
    await expect(new OpenVsxClient().searchExtensions({})).rejects.toThrow(/malformed JSON/)
  })
})

describe("OpenVsxClient — error taxonomy", () => {
  it("maps a rate-limited response to the rate_limit category", async () => {
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse(
        { message: "slow down" },
        { status: 429, headers: { "x-ratelimit-limit": "10800" } }
      )
    )

    const error = await new OpenVsxClient().searchExtensions({}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpenVsxError)
    expect((error as OpenVsxError).category).toBe("rate_limit")
    expect((error as OpenVsxError).retryable).toBe(true)
    expect((error as OpenVsxError).status).toBe(429)
  })

  it("maps a transport failure to the network category", async () => {
    proxyFetchMock.mockRejectedValueOnce(new Error("Proxy request failed: ECONNREFUSED"))
    const error = await new OpenVsxClient().searchExtensions({}).catch((e: unknown) => e)
    expect((error as OpenVsxError).category).toBe("network")
    expect((error as OpenVsxError).retryable).toBe(true)
  })
})

describe("OpenVsxClient — requests", () => {
  it("builds a search URL with server-side paging and pinned host", async () => {
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({ offset: 24, totalSize: 99, extensions: [] })
    )

    const result = await new OpenVsxClient().searchExtensions({
      query: "rust",
      category: "Programming Languages",
      size: 12,
      offset: 24,
      sortBy: "downloadCount",
      sortOrder: "desc",
    })

    const url = new URL(proxyFetchMock.mock.calls[0][0] as string)
    expect(url.origin).toBe(BASE)
    expect(url.pathname).toBe("/api/-/search")
    expect(url.searchParams.get("query")).toBe("rust")
    expect(url.searchParams.get("category")).toBe("Programming Languages")
    expect(url.searchParams.get("size")).toBe("12")
    expect(url.searchParams.get("offset")).toBe("24")
    expect(url.searchParams.get("sortBy")).toBe("downloadCount")
    expect(url.searchParams.get("sortOrder")).toBe("desc")
    expect(proxyFetchMock.mock.calls[0][1]).toMatchObject({ timeout: 15_000 })
    expect(result).toEqual({ offset: 24, totalSize: 99, extensions: [] })
  })

  it("queries a single extension and surfaces the richer /query fields", async () => {
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({
        offset: 0,
        totalSize: 1,
        extensions: [
          {
            ...searchEntry(),
            files: {
              ...searchEntry().files,
              manifest: `${BASE}/api/esbenp/prettier-vscode/12.4.0/file/package.json`,
            },
            targetPlatform: "universal",
            engines: { vscode: "^1.101.0" },
            categories: ["Formatters"],
            extensionKind: ["workspace", "web"],
            tags: ["css", "javascript"],
            dependencies: [],
            bundledExtensions: [
              { url: `${BASE}/api/redhat/java`, namespace: "redhat", extension: "java" },
            ],
            preRelease: false,
            versionAlias: ["latest"],
            downloadable: true,
            license: "MIT",
            publishedBy: { loginName: "esbenp" },
            namespaceAccess: "restricted",
            allVersionsUrl: `${BASE}/api/esbenp/prettier-vscode/versions`,
          },
        ],
      })
    )

    const result = await new OpenVsxClient().queryExtension({
      extensionId: "esbenp.prettier-vscode",
      targetPlatform: "darwin-arm64",
      includeAllVersions: true,
    })

    const url = new URL(proxyFetchMock.mock.calls[0][0] as string)
    expect(url.pathname).toBe("/api/-/query")
    expect(url.searchParams.get("extensionId")).toBe("esbenp.prettier-vscode")
    expect(url.searchParams.get("targetPlatform")).toBe("darwin-arm64")
    expect(url.searchParams.get("includeAllVersions")).toBe("true")

    const entry = result.extensions[0]
    expect(entry.categories).toEqual(["Formatters"])
    expect(entry.engines).toEqual({ vscode: "^1.101.0" })
    expect(entry.downloadable).toBe(true)
    expect(entry.preRelease).toBe(false)
    expect(entry.files.manifest).toContain("/file/package.json")
    expect(entry.bundledExtensions).toEqual([
      { url: `${BASE}/api/redhat/java`, namespace: "redhat", extension: "java" },
    ])
  })

  it("treats a platform miss as totalSize 0 rather than an error", async () => {
    // Verified live: rust-analyzer + targetPlatform=alpine-arm64 -> HTTP 200,
    // empty list. The universal retry in openvsx-platform depends on this.
    proxyFetchMock.mockResolvedValueOnce(jsonResponse({ offset: 0, totalSize: 0, extensions: [] }))
    const result = await new OpenVsxClient().queryExtension({
      extensionId: "rust-lang.rust-analyzer",
      targetPlatform: "alpine-arm64",
    })
    expect(result.totalSize).toBe(0)
    expect(result.extensions).toEqual([])
  })

  it("rejects a malformed extension id before spending a request", async () => {
    const client = new OpenVsxClient()
    await expect(client.queryExtension({ extensionId: "no-separator" })).rejects.toThrow(
      /namespace\.name/
    )
    await expect(client.queryExtension({ extensionId: "..".concat(".x") })).rejects.toThrow()
    expect(proxyFetchMock).not.toHaveBeenCalled()
  })
})

describe("OpenVsxClient — fetchManifest", () => {
  it("fetches and returns the package.json object", async () => {
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({ name: "prettier-vscode", publisher: "esbenp", contributes: {} })
    )
    const manifest = await new OpenVsxClient().fetchManifest(
      `${BASE}/api/esbenp/prettier-vscode/12.4.0/file/package.json`
    )
    expect(manifest.publisher).toBe("esbenp")
  })

  it("refuses an off-site manifest URL without fetching it", async () => {
    await expect(
      new OpenVsxClient().fetchManifest("https://evil.example.com/package.json")
    ).rejects.toThrow(/off-site files\.manifest/)
    expect(proxyFetchMock).not.toHaveBeenCalled()
  })

  it("rejects a manifest that is not a JSON object", async () => {
    proxyFetchMock.mockResolvedValueOnce(jsonResponse(["not", "an", "object"]))
    await expect(
      new OpenVsxClient().fetchManifest(`${BASE}/api/x/y/1.0.0/file/package.json`)
    ).rejects.toThrow(/not a JSON object/)
  })
})

describe("OpenVsxClient — caching", () => {
  it("serves repeat searches from cache", async () => {
    proxyFetchMock.mockResolvedValueOnce(jsonResponse({ offset: 0, totalSize: 0, extensions: [] }))
    const client = new OpenVsxClient()
    await client.searchExtensions({ query: "a" })
    await client.searchExtensions({ query: "a" })
    expect(proxyFetchMock).toHaveBeenCalledTimes(1)
  })

  it("expires cached responses after the TTL", async () => {
    const client = new OpenVsxClient({ cacheTimeout: 10 })
    proxyFetchMock.mockImplementation(alwaysJson(EMPTY_SEARCH))
    const nowSpy = jest.spyOn(Date, "now")
    nowSpy.mockReturnValue(1_000)
    await client.searchExtensions({ query: "a" })
    nowSpy.mockReturnValue(1_000_000)
    await client.searchExtensions({ query: "a" })
    expect(proxyFetchMock).toHaveBeenCalledTimes(2)
    nowSpy.mockRestore()
  })

  it("collapses a burst of identical failures into one request", async () => {
    // Without the negative cache, one "check for updates" re-hits an
    // unreachable registry once per installed extension.
    proxyFetchMock.mockRejectedValue(new Error("network unreachable"))
    const client = new OpenVsxClient()

    await expect(client.queryExtension({ extensionId: "a.b" })).rejects.toThrow()
    await expect(client.queryExtension({ extensionId: "a.b" })).rejects.toThrow()
    await expect(client.queryExtension({ extensionId: "a.b" })).rejects.toThrow()

    expect(proxyFetchMock).toHaveBeenCalledTimes(1)
  })

  it("retries after the negative-cache window expires", async () => {
    proxyFetchMock.mockRejectedValue(new Error("network unreachable"))
    const client = new OpenVsxClient()
    const nowSpy = jest.spyOn(Date, "now")
    nowSpy.mockReturnValue(1_000)
    await expect(client.queryExtension({ extensionId: "a.b" })).rejects.toThrow()
    nowSpy.mockReturnValue(1_000 + 61_000)
    await expect(client.queryExtension({ extensionId: "a.b" })).rejects.toThrow()
    expect(proxyFetchMock).toHaveBeenCalledTimes(2)
    nowSpy.mockRestore()
  })

  it("bounds the negative cache so repeated failures can't grow it forever", async () => {
    proxyFetchMock.mockRejectedValue(new Error("network unreachable"))
    const client = new OpenVsxClient()
    for (let i = 0; i < 101; i++) {
      await expect(client.queryExtension({ extensionId: `ns.ext${i}` })).rejects.toThrow()
    }
    expect(proxyFetchMock).toHaveBeenCalledTimes(101)
    // The oldest remembered failure was evicted, so it costs a request again.
    await expect(client.queryExtension({ extensionId: "ns.ext0" })).rejects.toThrow()
    expect(proxyFetchMock).toHaveBeenCalledTimes(102)
  })

  it("clearCache drops both positive and negative entries", async () => {
    proxyFetchMock.mockImplementation(alwaysJson(EMPTY_SEARCH))
    const client = new OpenVsxClient()
    await client.searchExtensions({ query: "a" })
    client.clearCache()
    await client.searchExtensions({ query: "a" })
    expect(proxyFetchMock).toHaveBeenCalledTimes(2)
  })

  it("evicts the oldest entry beyond the cache cap", async () => {
    proxyFetchMock.mockImplementation(alwaysJson(EMPTY_SEARCH))
    const client = new OpenVsxClient()
    for (let i = 0; i < 101; i++) await client.searchExtensions({ query: `q${i}` })
    expect(proxyFetchMock).toHaveBeenCalledTimes(101)
    // The first key was evicted, so it re-fetches; a recent one still hits.
    await client.searchExtensions({ query: "q0" })
    expect(proxyFetchMock).toHaveBeenCalledTimes(102)
    await client.searchExtensions({ query: "q100" })
    expect(proxyFetchMock).toHaveBeenCalledTimes(102)
  })
})

describe("getOpenVsxClient", () => {
  it("returns a singleton that reset clears", () => {
    const first = getOpenVsxClient()
    expect(getOpenVsxClient()).toBe(first)
    resetOpenVsxClient()
    expect(getOpenVsxClient()).not.toBe(first)
  })

  it("honours a configured mirror base URL", async () => {
    proxyFetchMock.mockResolvedValueOnce(jsonResponse({ offset: 0, totalSize: 0, extensions: [] }))
    const client = getOpenVsxClient({ baseUrl: "https://vsx.internal.example" })
    await client.searchExtensions({ query: "x" })
    expect(proxyFetchMock.mock.calls[0][0]).toContain("https://vsx.internal.example/api/-/search")
  })

  it("pins same-origin against the configured mirror, not the default host", async () => {
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({ offset: 0, totalSize: 1, extensions: [searchEntry()] })
    )
    // Entry points at open-vsx.org while the client is configured for a mirror.
    const client = new OpenVsxClient({ baseUrl: "https://vsx.internal.example" })
    await expect(client.searchExtensions({})).rejects.toThrow(/off-site/)
  })
})
