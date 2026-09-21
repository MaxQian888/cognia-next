jest.mock("@/lib/router-fusion/gate/load-engine", () => ({
  loadRouterFusionHost: jest.fn(),
}))

/**
 * Binding-level test: `@/lib/search/standalone-answer` supplies the app's
 * `StandaloneAnswerDeps` — settings-store config plus the BYOK model built
 * through the standalone transport seam (ADR-0068 E2). The pipeline behavior
 * itself is covered in `@cognia/web-search`.
 */

import type { ProviderResolution } from "@/lib/ai/provider-consumption"
import type { StandaloneAnswerDeps } from "@cognia/web-search/standalone-answer"

const runCoreMock = jest.fn()

jest.mock("@cognia/web-search/standalone-answer", () => ({
  runStandaloneSearchAnswer: (...args: unknown[]) => runCoreMock(...args),
  StandaloneSearchError: class StandaloneSearchError extends Error {},
  buildAnswerPrompt: jest.fn(),
}))

const settingsRef: { current: Record<string, unknown> | undefined } = { current: undefined }
const resolveMock = jest.fn<ProviderResolution, [unknown]>()
const createModelMock = jest.fn(() => ({ __model: true }))
const configuredSearchMock = jest.fn()

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: settingsRef.current }) },
}))
jest.mock("@/lib/ai/chat/resolve-standalone-provider", () => ({
  resolveStandaloneProvider: (s: unknown) => resolveMock(s),
}))
jest.mock("@/lib/ai/provider-consumption", () => ({
  createFeatureProviderModel: (...args: unknown[]) => createModelMock(...(args as [])),
}))
jest.mock("@/lib/runtime/streaming-fetch", () => ({
  getStreamingFetch: () => "fetch-impl",
  browserDirectHeaders: (p: string) => ({ proto: p }),
}))
jest.mock("@/lib/search/configured-search", () => ({
  searchWithAppSettings: (...args: unknown[]) => configuredSearchMock(...args),
}))

import { runStandaloneSearchAnswer } from "./standalone-answer"
import { __resetBreakerForTesting } from "@/lib/router-fusion/gate/breaker"
import { loadRouterFusionHost } from "@/lib/router-fusion/gate/load-engine"
import type { RouterFusionHost } from "@/lib/router-fusion/gate/load-engine"
import type { BeginLedgeredUtilityCallInput } from "@/lib/router-fusion/gate/utility-ledger"

const loadHostMock = loadRouterFusionHost as jest.Mock

const resolved: ProviderResolution = {
  kind: "resolved",
  providerId: "anthropic",
  protocol: "anthropic",
  apiKey: "sk-ant",
  baseURL: undefined,
  model: "claude-sonnet-4-6",
  isCustomProvider: false,
  useProxy: false,
}

function capturedDeps(): StandaloneAnswerDeps {
  expect(runCoreMock).toHaveBeenCalledTimes(1)
  return runCoreMock.mock.calls[0][1] as StandaloneAnswerDeps
}

beforeEach(() => {
  runCoreMock.mockReset().mockResolvedValue({ query: "q", sources: [], provider: "exa" })
  resolveMock.mockReset().mockReturnValue(resolved)
  createModelMock.mockClear()
  settingsRef.current = {
    searchProviders: { exa: { providerId: "exa", enabled: true } },
    searchMaxResults: 7,
  }
})

describe("lib/search/standalone-answer binding", () => {
  it("injects the configured app search executor into the standalone pipeline", async () => {
    await runStandaloneSearchAnswer({ query: "hello", maxResults: 3 })
    const params = runCoreMock.mock.calls[0][0] as {
      query: string
      maxResults: number
      searchImpl: (query: string, options: unknown) => Promise<unknown>
    }
    expect(params).toMatchObject({ query: "hello", maxResults: 3 })
    await params.searchImpl("hello", { maxResults: 3 })
    expect(configuredSearchMock).toHaveBeenCalledWith("hello", {
      options: { maxResults: 3 },
    })
  })

  it("preserves an explicit test search implementation", async () => {
    const searchImpl = jest.fn()
    await runStandaloneSearchAnswer({ query: "hello", searchImpl })
    expect(runCoreMock.mock.calls[0][0]).toEqual({ query: "hello", searchImpl })
  })

  it("getConfig reads providerSettings + maxResults from the settings store", async () => {
    await runStandaloneSearchAnswer({ query: "hello" })
    const deps = capturedDeps()
    expect(deps.getConfig()).toEqual({
      providerSettings: { exa: { providerId: "exa", enabled: true } },
      maxResults: 7,
    })
  })

  it("getConfig tolerates an unhydrated store", async () => {
    settingsRef.current = undefined
    await runStandaloneSearchAnswer({ query: "hello" })
    const deps = capturedDeps()
    expect(deps.getConfig()).toEqual({ providerSettings: undefined, maxResults: undefined })
  })

  it("resolveModel builds the model through the standalone transport seam", async () => {
    await runStandaloneSearchAnswer({ query: "hello" })
    const deps = capturedDeps()
    const model = deps.resolveModel()
    expect(model).toEqual({ __model: true })
    expect(resolveMock).toHaveBeenCalledWith(settingsRef.current)
    expect(createModelMock).toHaveBeenCalledWith(resolved, {
      fetch: "fetch-impl",
      headers: { proto: "anthropic" },
    })
  })

  it("resolveModel returns null when no provider resolves", async () => {
    resolveMock.mockReturnValue({
      kind: "unresolved",
      reason: "no key",
      attemptedProviderIds: [],
    })
    await runStandaloneSearchAnswer({ query: "hello" })
    const deps = capturedDeps()
    expect(deps.resolveModel()).toBeNull()
    expect(createModelMock).not.toHaveBeenCalled()
  })

  it("injects the app PII sanitizer and untrusted-content wrapper", async () => {
    await runStandaloneSearchAnswer({ query: "hello" })
    const deps = capturedDeps()
    expect(deps.sanitizeText?.("alice@example.com")).not.toContain("alice@example.com")
    expect(deps.wrapUntrustedContent?.("source text")).toContain("Untrusted web content")
  })
})

// --- Router + Fusion ledger (ADR-0188 D27) -----------------------------------
// The synthesis is a utility generation: with `utilityLedger` on the binding
// hands the package a ledgered seam bound to the very provider `resolveModel`
// resolved. Off, it hands it nothing.

describe("lib/search/standalone-answer ledger seam", () => {
  const reserved: BeginLedgeredUtilityCallInput[] = []

  beforeEach(() => {
    __resetBreakerForTesting()
    reserved.length = 0
    createModelMock.mockReturnValue({ modelId: "claude-sonnet-4-6" } as never)
    loadHostMock.mockReset().mockResolvedValue({
      beginLedgeredUtilityCall: async (input: BeginLedgeredUtilityCallInput) => {
        reserved.push(input)
        return {
          kind: "granted",
          handle: {
            runId: "run-1",
            maxOutputTokens: 900,
            succeeded: async () => {},
            failed: async () => {},
            unknown: async () => {},
          },
        }
      },
    } as unknown as RouterFusionHost)
  })

  it("[ACC:OFF-03] hands the pipeline no seam while the switch is off", async () => {
    await runStandaloneSearchAnswer({ query: "hello" })
    const deps = capturedDeps()
    deps.resolveModel()
    expect(deps.resolveGenerate?.()).toBeUndefined()
    expect(loadHostMock).not.toHaveBeenCalled()
  })

  it("hands no seam when no provider resolved, even with the switch on", async () => {
    settingsRef.current = {
      ...settingsRef.current,
      routerFusion: { enabled: true, surfaces: { utilityLedger: true } },
    }
    resolveMock.mockReturnValue({ kind: "unresolved", reason: "no key", attemptedProviderIds: [] })
    await runStandaloneSearchAnswer({ query: "hello" })
    const deps = capturedDeps()
    expect(deps.resolveModel()).toBeNull()
    expect(deps.resolveGenerate?.()).toBeUndefined()
  })

  it("reserves the synthesis on the ledger, through the real pipeline, when the switch is on", async () => {
    settingsRef.current = {
      ...settingsRef.current,
      searchProviders: { exa: { providerId: "exa", enabled: true, apiKey: "exa-key" } },
      routerFusion: { enabled: true, surfaces: { utilityLedger: true } },
    }
    // Run the real package pipeline for this one case: search and the model call
    // are injected, everything between them is the shipped code.
    const core = jest.requireActual("@cognia/web-search/standalone-answer") as {
      runStandaloneSearchAnswer: typeof runStandaloneSearchAnswer
    }
    runCoreMock.mockImplementation(
      core.runStandaloneSearchAnswer as unknown as (...args: unknown[]) => unknown
    )
    const generateTextImpl = jest.fn().mockResolvedValue({
      text: "Cited answer [1].",
      usage: { inputTokens: 300, outputTokens: 50 },
    })

    const out = await runStandaloneSearchAnswer({
      query: "hello",
      searchImpl: jest.fn().mockResolvedValue({
        provider: "exa",
        query: "hello",
        results: [{ title: "A", url: "https://a.com", content: "alpha", score: 1 }],
        responseTime: 5,
      }) as never,
      generateTextImpl: generateTextImpl as never,
    })

    expect(out.answer).toBe("Cited answer [1].")
    expect(reserved).toEqual([
      expect.objectContaining({
        featureId: "standalone-search-answer:web-search.standalone-answer",
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
        workspaceId: null,
      }),
    ])
    expect(generateTextImpl).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 900, maxRetries: 0 })
    )
  })
})
