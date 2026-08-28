import type { AppSettings } from "@cognia/agent-config-types"
import { getSearchCache } from "@cognia/web-search/search-cache"
import {
  formatSearchResultsForLLM,
  setSearchUsageReporter,
} from "@cognia/web-search/search-service"

const routeSearchMock = jest.fn()

jest.mock("@cognia/web-search/search-type-router", () => ({
  routeSearch: (...args: unknown[]) => routeSearchMock(...args),
}))

import { mergeWebSearchSourcesIntoLastAssistant } from "@/lib/claude/adapter"
import { wrapUntrustedContent } from "@/lib/web/untrusted-content"
import { searchWithSettings } from "./configured-search-core"

const settings = {
  defaultSearchProvider: "tavily",
  searchCacheEnabled: true,
  searchCacheTTL: 60_000,
  searchCacheMaxEntries: 10,
  searchProviders: {
    tavily: {
      providerId: "tavily",
      enabled: true,
      apiKey: "tvly-test-key-1234567890",
      priority: 1,
    },
  },
} as AppSettings

describe("configured search round trip", () => {
  const usageReporter = jest.fn()

  beforeEach(() => {
    getSearchCache().clear()
    routeSearchMock.mockReset().mockResolvedValue({
      provider: "tavily",
      query: "Cognia",
      results: [
        {
          title: "Cognia docs",
          url: "https://example.com/docs",
          content: "Current documentation",
          score: 0.9,
        },
      ],
      responseTime: 3,
    })
    usageReporter.mockReset()
    setSearchUsageReporter(usageReporter)
  })

  afterAll(() => setSearchUsageReporter(null))

  it("requests one provider, reuses cache without billing, and persists clickable sources", async () => {
    const first = await searchWithSettings("Cognia", { settings, optimizeQuery: false })
    const second = await searchWithSettings("Cognia", { settings, optimizeQuery: false })
    await Promise.resolve()

    expect(second).toEqual(first)
    expect(routeSearchMock).toHaveBeenCalledTimes(1)
    expect(usageReporter).toHaveBeenCalledTimes(1)

    const modelContext = wrapUntrustedContent(formatSearchResultsForLLM(first))
    expect(modelContext).toContain("Untrusted web content")
    expect(modelContext).toContain("https://example.com/docs")

    const messages = mergeWebSearchSourcesIntoLastAssistant(
      [{ id: "assistant", role: "assistant", parts: [{ type: "text", text: "Answer" }] }] as never,
      { provider: first.provider, results: first.results }
    )
    expect(messages[0]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "sources",
          sources: [
            expect.objectContaining({
              origin: "cognia-web",
              url: "https://example.com/docs",
            }),
          ],
        }),
      ])
    )
  })
})
