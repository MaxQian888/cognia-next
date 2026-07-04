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

  it("routes web_search to the core with provider settings", async () => {
    const providerSettings = { tavily: { providerId: "tavily", enabled: true } } as never
    await runWebBuiltinTool(WEB_SEARCH_TOOL_NAME, { query: "q" }, { providerSettings })
    expect(mockSearch).toHaveBeenCalledWith(
      { query: "q" },
      expect.objectContaining({ providerSettings })
    )
  })

  it("returns an error for an unknown tool name", async () => {
    expect(await runWebBuiltinTool("nope", {}, {})).toEqual({
      ok: false,
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
