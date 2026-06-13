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

const mockFetch = webFetch as jest.Mock
const mockSearch = webSearch as jest.Mock

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

  it("routes web_fetch to the core with fetch deps", async () => {
    await runWebBuiltinTool(WEB_FETCH_TOOL_NAME, { url: "u" }, { userAgent: "UA" })
    expect(mockFetch).toHaveBeenCalledWith(
      { url: "u" },
      expect.objectContaining({ userAgent: "UA" })
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
})
