import type { ProviderResolution } from "@/lib/ai/provider-consumption"
import type { SearchProviderSettings, SearchProviderType, SearchResponse } from "@/lib/search/types"

const settingsRef: { current: Record<string, unknown> | undefined } = { current: undefined }
const resolveMock = jest.fn<ProviderResolution, [unknown]>()
const createModelMock = jest.fn(() => ({ __model: true }))

jest.mock("ai", () => ({ generateText: jest.fn() }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: settingsRef.current }) },
}))
jest.mock("@/lib/search/search-service", () => ({ search: jest.fn() }))
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

import { generateText } from "ai"
import { search as moduleSearch } from "@/lib/search/search-service"

import {
  buildAnswerPrompt,
  runStandaloneSearchAnswer,
  StandaloneSearchError,
} from "./standalone-answer"

const mockGenerateText = generateText as jest.Mock
const mockModuleSearch = moduleSearch as jest.Mock

const enabledExa: SearchProviderSettings = {
  providerId: "exa",
  apiKey: "exa-test-key",
  enabled: true,
  priority: 1,
}

function withSearchProviders(extra?: Record<string, unknown>) {
  return {
    searchProviders: { exa: enabledExa } as Record<SearchProviderType, SearchProviderSettings>,
    searchMaxResults: 5,
    ...extra,
  }
}

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

const searchResponse: SearchResponse = {
  provider: "exa",
  query: "q",
  answer: "provider-native answer",
  results: [
    { title: "A", url: "https://a.com/x", content: "alpha content", score: 0.9 },
    { title: "B", url: "https://b.com/y", content: "beta content", score: 0.8 },
  ],
  responseTime: 12,
}

beforeEach(() => {
  settingsRef.current = withSearchProviders()
  resolveMock.mockReset()
  createModelMock.mockClear()
  mockGenerateText.mockReset()
  mockModuleSearch.mockReset()
  resolveMock.mockReturnValue(resolved)
})

describe("buildAnswerPrompt", () => {
  it("numbers sources and includes urls", () => {
    const prompt = buildAnswerPrompt("what is x", searchResponse.results)
    expect(prompt).toContain("Question: what is x")
    expect(prompt).toContain("[1] A")
    expect(prompt).toContain("URL: https://a.com/x")
    expect(prompt).toContain("[2] B")
  })

  it("truncates long source content", () => {
    const long = { title: "L", url: "https://l.com", content: "z".repeat(5000), score: 1 }
    const prompt = buildAnswerPrompt("q", [long])
    // 1500 cap + surrounding text — far below the raw 5000.
    expect(prompt.length).toBeLessThan(1800)
  })

  it("tolerates a source with no content", () => {
    const prompt = buildAnswerPrompt("q", [
      { title: "T", url: "https://t.com", content: undefined as never, score: 1 },
    ])
    expect(prompt).toContain("[1] T")
  })
})

describe("runStandaloneSearchAnswer", () => {
  it("rejects an empty query", async () => {
    await expect(runStandaloneSearchAnswer({ query: "   " })).rejects.toMatchObject({
      code: "empty-query",
    })
  })

  it("rejects when no search provider is enabled", async () => {
    settingsRef.current = { searchProviders: {} }
    await expect(runStandaloneSearchAnswer({ query: "hi" })).rejects.toMatchObject({
      code: "no-search-provider",
    })
  })

  it("rejects when settings have no searchProviders at all", async () => {
    settingsRef.current = {}
    await expect(runStandaloneSearchAnswer({ query: "hi" })).rejects.toMatchObject({
      code: "no-search-provider",
    })
  })

  it("wraps a search failure as search-failed", async () => {
    const searchImpl = jest.fn().mockRejectedValue(new Error("network down"))
    await expect(
      runStandaloneSearchAnswer({ query: "hi", searchImpl: searchImpl as never })
    ).rejects.toMatchObject({ code: "search-failed", message: "network down" })
  })

  it("synthesizes a cited answer through the standalone provider", async () => {
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockResolvedValue({ text: "Cited answer [1]." })
    const out = await runStandaloneSearchAnswer({
      query: "hi",
      searchImpl: searchImpl as never,
      generateTextImpl: generateTextImpl as never,
    })
    expect(out.answer).toBe("Cited answer [1].")
    expect(out.sources).toHaveLength(2)
    expect(out.provider).toBe("exa")
    expect(out.modelUnavailable).toBeUndefined()
    // model built from the resolved provider with the streaming transport seam
    expect(createModelMock).toHaveBeenCalledWith(resolved, {
      fetch: "fetch-impl",
      headers: { proto: "anthropic" },
    })
    // maxResults defaulted from settings.searchMaxResults
    expect(searchImpl).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ maxResults: 5, includeAnswer: true })
    )
  })

  it("falls back to the provider-native answer when the model returns empty text", async () => {
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockResolvedValue({ text: "   " })
    const out = await runStandaloneSearchAnswer({
      query: "hi",
      searchImpl: searchImpl as never,
      generateTextImpl: generateTextImpl as never,
    })
    expect(out.answer).toBe("provider-native answer")
  })

  it("returns sources with modelUnavailable when no model provider resolves", async () => {
    resolveMock.mockReturnValue({
      kind: "unresolved",
      reason: "no key",
      attemptedProviderIds: [],
    })
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const out = await runStandaloneSearchAnswer({ query: "hi", searchImpl: searchImpl as never })
    expect(out.modelUnavailable).toBe(true)
    expect(out.answer).toBe("provider-native answer")
    expect(out.sources).toHaveLength(2)
    expect(createModelMock).not.toHaveBeenCalled()
  })

  it("maps a synthesis failure to answer-failed", async () => {
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockRejectedValue(new Error("model 500"))
    await expect(
      runStandaloneSearchAnswer({
        query: "hi",
        searchImpl: searchImpl as never,
        generateTextImpl: generateTextImpl as never,
      })
    ).rejects.toMatchObject({ code: "answer-failed", message: "model 500" })
  })

  it("re-throws the original error when aborted mid-synthesis", async () => {
    const controller = new AbortController()
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const abortErr = new Error("aborted")
    const generateTextImpl = jest.fn().mockImplementation(() => {
      controller.abort()
      return Promise.reject(abortErr)
    })
    await expect(
      runStandaloneSearchAnswer({
        query: "hi",
        signal: controller.signal,
        searchImpl: searchImpl as never,
        generateTextImpl: generateTextImpl as never,
      })
    ).rejects.toBe(abortErr)
  })

  it("honors an explicit maxResults override", async () => {
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockResolvedValue({ text: "x" })
    await runStandaloneSearchAnswer({
      query: "hi",
      maxResults: 3,
      searchImpl: searchImpl as never,
      generateTextImpl: generateTextImpl as never,
    })
    expect(searchImpl).toHaveBeenCalledWith("hi", expect.objectContaining({ maxResults: 3 }))
  })

  it("exposes StandaloneSearchError with a code", () => {
    const e = new StandaloneSearchError("empty-query", "x")
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe("empty-query")
    expect(e.name).toBe("StandaloneSearchError")
  })

  it("uses the module-level search when no searchImpl is injected", async () => {
    mockModuleSearch.mockResolvedValue(searchResponse)
    resolveMock.mockReturnValue({ kind: "unresolved", reason: "x", attemptedProviderIds: [] })
    const out = await runStandaloneSearchAnswer({ query: "hi" })
    expect(mockModuleSearch).toHaveBeenCalled()
    expect(out.modelUnavailable).toBe(true)
  })

  it("uses the module-level generateText when no generateTextImpl is injected", async () => {
    mockGenerateText.mockResolvedValue({ text: "from module" })
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const out = await runStandaloneSearchAnswer({ query: "hi", searchImpl: searchImpl as never })
    expect(mockGenerateText).toHaveBeenCalled()
    expect(out.answer).toBe("from module")
  })

  it("stringifies a non-Error search rejection", async () => {
    const searchImpl = jest.fn().mockRejectedValue("string failure")
    await expect(
      runStandaloneSearchAnswer({ query: "hi", searchImpl: searchImpl as never })
    ).rejects.toMatchObject({ code: "search-failed", message: "string failure" })
  })

  it("stringifies a non-Error synthesis rejection", async () => {
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockRejectedValue("synth boom")
    await expect(
      runStandaloneSearchAnswer({
        query: "hi",
        searchImpl: searchImpl as never,
        generateTextImpl: generateTextImpl as never,
      })
    ).rejects.toMatchObject({ code: "answer-failed", message: "synth boom" })
  })

  it("defaults sources to [] when the response omits results", async () => {
    const searchImpl = jest.fn().mockResolvedValue({
      provider: "exa",
      query: "hi",
      responseTime: 1,
      results: undefined as never,
    })
    resolveMock.mockReturnValue({ kind: "unresolved", reason: "x", attemptedProviderIds: [] })
    const out = await runStandaloneSearchAnswer({ query: "hi", searchImpl: searchImpl as never })
    expect(out.sources).toEqual([])
  })

  it("falls back to the default max results when settings omit it", async () => {
    settingsRef.current = { searchProviders: { exa: enabledExa } }
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockResolvedValue({ text: "x" })
    await runStandaloneSearchAnswer({
      query: "hi",
      searchImpl: searchImpl as never,
      generateTextImpl: generateTextImpl as never,
    })
    expect(searchImpl).toHaveBeenCalledWith("hi", expect.objectContaining({ maxResults: 8 }))
  })
})
