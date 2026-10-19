import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "./schema"

const mockSearchWithSettings = jest.fn()
const mockUtilityClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...args: unknown[]) => mockUtilityClient(...args),
}))
jest.mock("@/lib/search/configured-search-core", () => ({
  searchWithSettings: (...args: unknown[]) => mockSearchWithSettings(...args),
}))

import { buildCliWebToolDeps } from "./web-tool-deps"

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work", providers: {}, ...overrides }
}

describe("buildCliWebToolDeps", () => {
  beforeEach(() => {
    mockSearchWithSettings.mockReset()
    mockUtilityClient.mockReset()
  })

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
    })
    expect(deps).not.toHaveProperty("searchOptions")
    expect(deps.searchExecutor).toEqual(expect.any(Function))
    await deps.searchExecutor?.("q", { maxResults: 2 })
    expect(mockSearchWithSettings).toHaveBeenCalledWith("q", {
      settings: expect.objectContaining({ defaultSearchProvider: "tavily" }),
      options: { maxResults: 2 },
      signal: undefined,
      scope: "cli",
      activeScope: expect.any(Function),
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

    expect(deps).not.toHaveProperty("searchOptions")
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

it("passes fresh Reader policy, trimmed vendor keys, cancellation and CLI profile scope", async () => {
  const deps = buildCliWebToolDeps(
    config({
      cliHome: "/profiles/one",
      search: {
        providers: { tavily: { apiKey: " key ", enabled: true }, deepseek: { apiKey: " " } },
      },
    })
  )
  expect(deps.readerPolicy?.externalFallback).toBe(false)
  expect(deps.readerPolicy?.enabled.has("jina")).toBe(false)
  expect(deps.credentialFor?.("tavily")).toBe("key")
  expect(deps.credentialFor?.("deepseek")).toBeUndefined()
  expect(deps.cache).toBeDefined()
  expect(deps.hostReachable).toMatchObject({
    direct: true,
    jina: true,
    fxtwitter: true,
    deepseek: true,
  })
  expect(deps.transportCancels).toBe(true)
  expect(deps.activeScope?.()).toBe("cli:/profiles/one")
  const signal = new AbortController().signal
  await deps.searchExecutor?.("query", { signal })
  expect(mockSearchWithSettings).toHaveBeenCalledWith(
    "query",
    expect.objectContaining({ signal, scope: deps.scope, activeScope: expect.any(Function) })
  )
  expect(deps).not.toHaveProperty("searchMaxResults")
})

it("builds query-focused extraction only with an available utility model", async () => {
  expect(buildCliWebToolDeps(config()).summarize).toBeUndefined()
  const complete = jest.fn().mockResolvedValue("focused")
  mockUtilityClient.mockReturnValue({ complete })
  const deps = buildCliWebToolDeps(config())
  const signal = new AbortController().signal
  await expect(deps.summarize?.("page content", "question", signal)).resolves.toBe("focused")
  expect(complete).toHaveBeenCalledWith(
    expect.stringContaining("page content"),
    expect.objectContaining({ abortSignal: signal })
  )
})

it("reads through the DNS-guarded transport and keeps private hosts blocked by default", () => {
  const deps = buildCliWebToolDeps(config())
  expect(deps.fetchImpl).toEqual(expect.any(Function))
  expect(deps.fetchImpl).not.toBe(globalThis.fetch)
  expect(deps.allowPrivateHosts).toBe(false)
})
