import type { SearchProviderSettings, SearchProviderType, SearchResponse } from "./types"

jest.mock("ai", () => ({ generateText: jest.fn() }))
jest.mock("./search-service", () => ({ search: jest.fn() }))

import { generateText } from "ai"
import { search as moduleSearch } from "./search-service"

import {
  buildAnswerPrompt,
  runStandaloneSearchAnswer,
  StandaloneSearchError,
  type StandaloneAnswerDeps,
} from "./standalone-answer"

const mockGenerateText = generateText as jest.Mock
const mockModuleSearch = moduleSearch as jest.Mock

const enabledExa: SearchProviderSettings = {
  providerId: "exa",
  apiKey: "exa-test-key",
  enabled: true,
  priority: 1,
}

const fakeModel = { __model: true }

/**
 * Host-config stand-in (the app binding reads its settings store; the tests
 * mutate this ref). `resolveModel` defaults to a resolved fake model —
 * individual tests flip it to null for the model-unavailable paths.
 */
const configRef: {
  current: {
    providerSettings: Partial<Record<SearchProviderType, SearchProviderSettings>> | undefined
    maxResults?: number
  }
} = { current: { providerSettings: { exa: enabledExa }, maxResults: 5 } }

const resolveModelMock = jest.fn<ReturnType<StandaloneAnswerDeps["resolveModel"]>, []>()

const deps: StandaloneAnswerDeps = {
  getConfig: () => configRef.current,
  resolveModel: () => resolveModelMock(),
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
  configRef.current = { providerSettings: { exa: enabledExa }, maxResults: 5 }
  resolveModelMock.mockReset()
  mockGenerateText.mockReset()
  mockModuleSearch.mockReset()
  resolveModelMock.mockReturnValue(fakeModel as never)
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

  it("sanitizes the query and frames sanitized source text as untrusted", () => {
    const sanitizeText = jest.fn((text: string) => text.replaceAll("secret@example.com", "[email]"))
    const wrapUntrustedContent = jest.fn((text: string) => `[UNTRUSTED]\n${text}`)
    const prompt = buildAnswerPrompt(
      "contact secret@example.com",
      [
        {
          title: "secret@example.com",
          url: "https://example.com/?owner=secret@example.com",
          content: "Email secret@example.com",
          score: 1,
        },
      ],
      { sanitizeText, wrapUntrustedContent }
    )

    expect(prompt).toContain("Question: contact [email]")
    expect(prompt).toContain("[UNTRUSTED]")
    expect(prompt).not.toContain("secret@example.com")
    expect(sanitizeText).toHaveBeenCalledTimes(2)
    expect(wrapUntrustedContent).toHaveBeenCalledTimes(1)
  })
})

describe("runStandaloneSearchAnswer", () => {
  it("rejects an empty query", async () => {
    await expect(runStandaloneSearchAnswer({ query: "   " }, deps)).rejects.toMatchObject({
      code: "empty-query",
    })
  })

  it("rejects when no search provider is enabled", async () => {
    configRef.current = { providerSettings: {} }
    await expect(runStandaloneSearchAnswer({ query: "hi" }, deps)).rejects.toMatchObject({
      code: "no-search-provider",
    })
  })

  it("rejects when the host config has no providerSettings at all", async () => {
    configRef.current = { providerSettings: undefined }
    await expect(runStandaloneSearchAnswer({ query: "hi" }, deps)).rejects.toMatchObject({
      code: "no-search-provider",
    })
  })

  it("wraps a search failure as search-failed", async () => {
    const searchImpl = jest.fn().mockRejectedValue(new Error("network down"))
    await expect(
      runStandaloneSearchAnswer({ query: "hi", searchImpl: searchImpl as never }, deps)
    ).rejects.toMatchObject({ code: "search-failed", message: "network down" })
  })

  it("synthesizes a cited answer through the injected model", async () => {
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockResolvedValue({ text: "Cited answer [1]." })
    const out = await runStandaloneSearchAnswer(
      {
        query: "hi",
        searchImpl: searchImpl as never,
        generateTextImpl: generateTextImpl as never,
      },
      deps
    )
    expect(out.answer).toBe("Cited answer [1].")
    expect(out.sources).toHaveLength(2)
    expect(out.provider).toBe("exa")
    expect(out.modelUnavailable).toBeUndefined()
    // The injected model is passed straight to generateText.
    expect(generateTextImpl).toHaveBeenCalledWith(expect.objectContaining({ model: fakeModel }))
    // maxResults defaulted from the host config
    expect(searchImpl).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ maxResults: 5, includeAnswer: true })
    )
  })

  it("routes every model prompt through the host PII and untrusted-content gates", async () => {
    const searchImpl = jest.fn().mockResolvedValue({
      ...searchResponse,
      results: [
        {
          title: "Private secret@example.com",
          url: "https://example.com/private",
          content: "Contact secret@example.com",
          score: 1,
        },
      ],
    })
    const generateTextImpl = jest.fn().mockResolvedValue({ text: "answer" })
    const sanitizeText = jest.fn((text: string) => text.replaceAll("secret@example.com", "[email]"))
    const wrapUntrustedContent = jest.fn((text: string) => `[UNTRUSTED]\n${text}`)

    await runStandaloneSearchAnswer(
      {
        query: "find secret@example.com",
        searchImpl: searchImpl as never,
        generateTextImpl: generateTextImpl as never,
      },
      { ...deps, sanitizeText, wrapUntrustedContent }
    )

    const call = generateTextImpl.mock.calls[0][0] as { prompt: string }
    expect(call.prompt).toContain("Question: find [email]")
    expect(call.prompt).toContain("[UNTRUSTED]")
    expect(call.prompt).not.toContain("secret@example.com")
  })

  it("falls back to the provider-native answer when the model returns empty text", async () => {
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockResolvedValue({ text: "   " })
    const out = await runStandaloneSearchAnswer(
      {
        query: "hi",
        searchImpl: searchImpl as never,
        generateTextImpl: generateTextImpl as never,
      },
      deps
    )
    expect(out.answer).toBe("provider-native answer")
  })

  it("returns sources with modelUnavailable when the host resolves no model", async () => {
    resolveModelMock.mockReturnValue(null)
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const out = await runStandaloneSearchAnswer(
      { query: "hi", searchImpl: searchImpl as never },
      deps
    )
    expect(out.modelUnavailable).toBe(true)
    expect(out.answer).toBe("provider-native answer")
    expect(out.sources).toHaveLength(2)
  })

  it("maps a synthesis failure to answer-failed", async () => {
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockRejectedValue(new Error("model 500"))
    await expect(
      runStandaloneSearchAnswer(
        {
          query: "hi",
          searchImpl: searchImpl as never,
          generateTextImpl: generateTextImpl as never,
        },
        deps
      )
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
      runStandaloneSearchAnswer(
        {
          query: "hi",
          signal: controller.signal,
          searchImpl: searchImpl as never,
          generateTextImpl: generateTextImpl as never,
        },
        deps
      )
    ).rejects.toBe(abortErr)
  })

  it("honors an explicit maxResults override", async () => {
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockResolvedValue({ text: "x" })
    await runStandaloneSearchAnswer(
      {
        query: "hi",
        maxResults: 3,
        searchImpl: searchImpl as never,
        generateTextImpl: generateTextImpl as never,
      },
      deps
    )
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
    resolveModelMock.mockReturnValue(null)
    const out = await runStandaloneSearchAnswer({ query: "hi" }, deps)
    expect(mockModuleSearch).toHaveBeenCalled()
    expect(out.modelUnavailable).toBe(true)
  })

  it("uses the module-level generateText when no generateTextImpl is injected", async () => {
    mockGenerateText.mockResolvedValue({ text: "from module" })
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const out = await runStandaloneSearchAnswer(
      { query: "hi", searchImpl: searchImpl as never },
      deps
    )
    expect(mockGenerateText).toHaveBeenCalled()
    expect(out.answer).toBe("from module")
  })

  it("stringifies a non-Error search rejection", async () => {
    const searchImpl = jest.fn().mockRejectedValue("string failure")
    await expect(
      runStandaloneSearchAnswer({ query: "hi", searchImpl: searchImpl as never }, deps)
    ).rejects.toMatchObject({ code: "search-failed", message: "string failure" })
  })

  it("stringifies a non-Error synthesis rejection", async () => {
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockRejectedValue("synth boom")
    await expect(
      runStandaloneSearchAnswer(
        {
          query: "hi",
          searchImpl: searchImpl as never,
          generateTextImpl: generateTextImpl as never,
        },
        deps
      )
    ).rejects.toMatchObject({ code: "answer-failed", message: "synth boom" })
  })

  it("defaults sources to [] when the response omits results", async () => {
    const searchImpl = jest.fn().mockResolvedValue({
      provider: "exa",
      query: "hi",
      responseTime: 1,
      results: undefined as never,
    })
    resolveModelMock.mockReturnValue(null)
    const out = await runStandaloneSearchAnswer(
      { query: "hi", searchImpl: searchImpl as never },
      deps
    )
    expect(out.sources).toEqual([])
  })

  it("falls back to the default max results when the host config omits it", async () => {
    configRef.current = { providerSettings: { exa: enabledExa } }
    const searchImpl = jest.fn().mockResolvedValue(searchResponse)
    const generateTextImpl = jest.fn().mockResolvedValue({ text: "x" })
    await runStandaloneSearchAnswer(
      {
        query: "hi",
        searchImpl: searchImpl as never,
        generateTextImpl: generateTextImpl as never,
      },
      deps
    )
    expect(searchImpl).toHaveBeenCalledWith("hi", expect.objectContaining({ maxResults: 8 }))
  })
})
