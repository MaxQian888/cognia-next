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
