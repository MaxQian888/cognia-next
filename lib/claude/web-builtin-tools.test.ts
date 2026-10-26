import {
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_BUILTIN_PLUGIN_ID,
  buildWebBuiltinManifestEntries,
  isWebBuiltinTool,
  runWebBuiltinTool,
} from "./web-builtin-tools"

jest.mock("@/lib/web/web-tools-core", () => ({
  webFetch: jest.fn(async () => ({ ok: true, kind: "fetch" })),
  webSearch: jest.fn(async () => ({ ok: true, kind: "search" })),
}))

import { webFetch, webSearch } from "@/lib/web/web-tools-core"
import { getPluginRateLimiter, resetPluginRateLimiter } from "@/lib/plugin/security/rate-limiter"

const mockFetch = webFetch as jest.Mock
const mockSearch = webSearch as jest.Mock

beforeEach(() => {
  resetPluginRateLimiter()
  mockFetch.mockClear()
  mockSearch.mockClear()
})

describe("web-builtin-tools", () => {
  it("isWebBuiltinTool recognizes both tools and nothing else", () => {
    expect(isWebBuiltinTool(WEB_SEARCH_TOOL_NAME)).toBe(true)
    expect(isWebBuiltinTool(WEB_FETCH_TOOL_NAME)).toBe(true)
    expect(isWebBuiltinTool("read")).toBe(false)
  })

  it("builds two manifest entries tagged with the synthetic plugin id", () => {
    const entries = buildWebBuiltinManifestEntries()
    expect(entries.map((e) => e.name).sort()).toEqual(["web_fetch", "web_search"])
    for (const e of entries) {
      expect(e.pluginId).toBe(WEB_BUILTIN_PLUGIN_ID)
      expect(e.jsonSchema).toBeTruthy()
      expect(typeof e.description).toBe("string")
    }
  })

  it("exposes a prompt param on the web_fetch schema", () => {
    const fetchEntry = buildWebBuiltinManifestEntries().find((e) => e.name === WEB_FETCH_TOOL_NAME)!
    const props = (fetchEntry.jsonSchema as { properties: Record<string, unknown> }).properties
    expect(props.prompt).toBeTruthy()
  })

  it("routes web_fetch to the core with fetch deps incl. summarize + cache", async () => {
    const summarize = jest.fn()
    const cache = { get: jest.fn(), set: jest.fn() }
    await runWebBuiltinTool(
      WEB_FETCH_TOOL_NAME,
      { url: "u" },
      { userAgent: "UA", summarize, cache }
    )
    expect(mockFetch).toHaveBeenCalledWith(
      { url: "u" },
      expect.objectContaining({ userAgent: "UA", summarize, cache })
    )
  })

  it("routes web_search to the core with only the executor, verification and signal", async () => {
    const searchExecutor = jest.fn()
    const signal = new AbortController().signal
    const sourceVerification = { enabled: true } as never
    await runWebBuiltinTool(
      WEB_SEARCH_TOOL_NAME,
      { query: "q" },
      { searchExecutor, sourceVerification, signal, userAgent: "UA" }
    )
    // Fetch-side deps never leak into the search core.
    expect(mockSearch).toHaveBeenCalledWith(
      { query: "q" },
      { searchExecutor, sourceVerification, signal }
    )
  })

  it("exposes specialized search controls on the web_search schema", () => {
    const entry = buildWebBuiltinManifestEntries().find((e) => e.name === WEB_SEARCH_TOOL_NAME)!
    const props = (entry.jsonSchema as { properties: Record<string, { enum?: string[] }> })
      .properties
    expect(props.searchType.enum).toEqual(["general", "news", "academic", "images", "videos"])
    expect(props.engine).toBeTruthy()
    expect(props.allowFallback).toBeTruthy()
    expect(props.excerptChars).toBeTruthy()
    // "provider" is a preference, not a forced choice.
    expect(entry.description).not.toMatch(/force/i)
  })

  it("exposes the reader choice on the web_fetch schema", () => {
    const entry = buildWebBuiltinManifestEntries().find((e) => e.name === WEB_FETCH_TOOL_NAME)!
    const props = (entry.jsonSchema as { properties: Record<string, { enum?: string[] }> })
      .properties
    expect(props.reader.enum).toEqual([
      "direct",
      "platform",
      "fxtwitter",
      "jina",
      "tavily",
      "exa",
      "deepseek",
      "tinyfish",
    ])
    expect(props.allowFallback).toBeTruthy()
  })

  it("can build only the tool the turn routes through Cognia", () => {
    expect(buildWebBuiltinManifestEntries({ search: false }).map((e) => e.name)).toEqual([
      WEB_FETCH_TOOL_NAME,
    ])
    expect(buildWebBuiltinManifestEntries({ fetch: false }).map((e) => e.name)).toEqual([
      WEB_SEARCH_TOOL_NAME,
    ])
  })

  describe("web_fetch host disclosure (R08)", () => {
    const describeWith = (host: Parameters<typeof buildWebBuiltinManifestEntries>[1]) =>
      buildWebBuiltinManifestEntries({ search: false }, host)[0].description

    it("does not promise prompt extraction without a utility model", () => {
      const text = describeWith({ summarizer: false, distillation: "off", readers: ["direct"] })
      expect(text).toMatch(/cannot narrow/)
      expect(text).toContain("Enabled readers: direct.")
    })

    it("offers prompt extraction when a utility model exists", () => {
      expect(describeWith({ summarizer: true, distillation: "best-effort", readers: [] })).toMatch(
        /Pass `prompt`/
      )
    })

    it("discloses required distillation and its failure without a model", () => {
      expect(describeWith({ summarizer: true, distillation: "required", readers: [] })).toMatch(
        /distilled by a utility model/
      )
      expect(describeWith({ summarizer: false, distillation: "required", readers: [] })).toMatch(
        /reads will fail/
      )
    })
  })

  it("rejects stale web-tool calls after the master switch is disabled", async () => {
    const out = await runWebBuiltinTool(WEB_SEARCH_TOOL_NAME, { query: "q" }, { enabled: false })
    // The `code` is the part callers branch on — the sentence is for humans and
    // is free to change without breaking anyone.
    expect(out).toEqual({
      ok: false,
      code: "web-disabled",
      error: "Web tools are disabled in Settings.",
    })
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it("returns an error for an unknown tool name", async () => {
    expect(await runWebBuiltinTool("nope", {}, {})).toEqual({
      ok: false,
      code: "invalid-arguments",
      error: "unknown web tool: nope",
    })
  })

  it("forwards allowPrivateHosts + alwaysDistill to web_fetch", async () => {
    await runWebBuiltinTool(
      WEB_FETCH_TOOL_NAME,
      { url: "u" },
      { allowPrivateHosts: true, alwaysDistill: true }
    )
    expect(mockFetch).toHaveBeenCalledWith(
      { url: "u" },
      expect.objectContaining({ allowPrivateHosts: true, alwaysDistill: true })
    )
  })

  it("rate-limits web_fetch and returns a structured error instead of throwing", async () => {
    getPluginRateLimiter().setLimit("network:fetch", { capacity: 1, refillPerSecond: 0 })
    const first = await runWebBuiltinTool(WEB_FETCH_TOOL_NAME, { url: "u" }, {})
    expect((first as { ok: boolean }).ok).toBe(true)
    const second = (await runWebBuiltinTool(WEB_FETCH_TOOL_NAME, { url: "u" }, {})) as Record<
      string,
      unknown
    >
    expect(second.ok).toBe(false)
    expect(String(second.error)).toMatch(/rate limit/i)
    // The core is not invoked when the limiter refuses the call.
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("meters web_search on a separate bucket from web_fetch", async () => {
    getPluginRateLimiter().setLimit("network:search", { capacity: 1, refillPerSecond: 0 })
    await runWebBuiltinTool(WEB_SEARCH_TOOL_NAME, { query: "q" }, {})
    const blocked = (await runWebBuiltinTool(WEB_SEARCH_TOOL_NAME, { query: "q" }, {})) as Record<
      string,
      unknown
    >
    expect(blocked.ok).toBe(false)
    // web_fetch is unaffected — different operation bucket.
    const fetchOk = await runWebBuiltinTool(WEB_FETCH_TOOL_NAME, { url: "u" }, {})
    expect((fetchOk as { ok: boolean }).ok).toBe(true)
  })
})
