import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "./schema"

const mockSearchWithSettings = jest.fn()
jest.mock("@/lib/search/configured-search-core", () => ({
  searchWithSettings: (...args: unknown[]) => mockSearchWithSettings(...args),
}))

import { buildCliWebToolDeps } from "./web-tool-deps"

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", providers: {}, ...overrides }
}

describe("buildCliWebToolDeps", () => {
  beforeEach(() => mockSearchWithSettings.mockReset())

  it("builds explicit search deps without reading renderer state", async () => {
    mockSearchWithSettings.mockResolvedValue({
      provider: "tavily",
      query: "q",
      results: [],
      responseTime: 1,
    })
    const deps = buildCliWebToolDeps(
      config({
        search: {
          defaultProvider: "tavily",
          maxResults: 6,
          fallbackEnabled: false,
          safeSearch: "strict",
          providers: {
            tavily: { apiKey: "tvly", enabled: true, priority: 1 },
          },
        },
      })
    )

    // Provider settings, the fallback flag AND every search default ride inside
    // the executor's own settings snapshot (asserted below), not as a second
    // copy on the deps. `searchOptions` is deliberately absent: forwarding a
    // re-derivation of the same snapshot as request-level overrides is what let
    // a legacy default silently replace the policy the executor computed.
    expect(deps).toMatchObject({
      enabled: true,
      searchMaxResults: 6,
    })
    expect(deps.searchOptions).toBeUndefined()
    expect(deps.searchExecutor).toEqual(expect.any(Function))
    await deps.searchExecutor?.("q", { maxResults: 2 })
    expect(mockSearchWithSettings).toHaveBeenCalledWith("q", {
      settings: expect.objectContaining({ defaultSearchProvider: "tavily" }),
      options: { maxResults: 2 },
      useCache: true,
    })
  })

  it("sends no request-level search overrides, leaving every default to the executor", async () => {
    // `searchOptions` lands as `request.options`, which `searchWithSettings`
    // merges OVER the defaults it just computed from the SAME snapshot. Any
    // value re-derived here therefore competes with the policy that actually
    // runs — that override layer is how a legacy `defaultIncludeDomains`
    // silently replaced the user's selected domain filter. Nothing to override
    // means nothing to drift.
    const deps = buildCliWebToolDeps(
      config({
        search: {
          safeSearch: "strict",
          includeDomains: ["example.com"],
          providers: { tavily: { apiKey: "tvly", enabled: true, priority: 1 } },
        },
      })
    )

    expect(deps.searchOptions).toBeUndefined()
    await deps.searchExecutor?.("q", {})
    // The configured values still reach the search — through the snapshot the
    // executor derives them from, which is the single derivation.
    expect(mockSearchWithSettings).toHaveBeenCalledWith(
      "q",
      expect.objectContaining({
        settings: expect.objectContaining({
          searchSafeSearchLevel: "strict",
          defaultIncludeDomains: ["example.com"],
        }),
        options: {},
      })
    )
  })

  it("omits the executor when no provider is configured, so callers can tell", () => {
    // Presence of `searchExecutor` is the single truthful "search can run"
    // signal; attaching one that always fails would make it meaningless.
    expect(buildCliWebToolDeps(config({})).searchExecutor).toBeUndefined()
  })

  it("propagates the web-tools master switch", () => {
    expect(buildCliWebToolDeps(config({ webTools: false })).enabled).toBe(false)
  })
})
