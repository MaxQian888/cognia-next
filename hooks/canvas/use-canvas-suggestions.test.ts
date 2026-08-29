/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const generateTextMock = jest.fn()
jest.mock("ai", () => ({
  generateText: (args: unknown) => generateTextMock(args),
}))

const addSuggestionMock = jest.fn()
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: <T>(selector: (s: { addSuggestion: typeof addSuggestionMock }) => T): T =>
    selector({ addSuggestion: addSuggestionMock }),
}))

const settingsRef = { current: { apiKey: "k" } as { apiKey?: string } | null }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T>(selector: (s: { settings: typeof settingsRef.current }) => T): T =>
    selector({ settings: settingsRef.current }),
}))

interface CanvasAiRef {
  maxSuggestions: number
  contextLines: number
  suggestionProvider: "default" | "custom"
  customProviderUrl?: string
}
const aiRef: { current: CanvasAiRef } = {
  current: { maxSuggestions: 5, contextLines: 50, suggestionProvider: "default" },
}
jest.mock("@/stores/canvas/canvas-settings-store", () => ({
  useCanvasSettingsStore: <T>(selector: (s: { settings: { ai: CanvasAiRef } }) => T): T =>
    selector({ settings: { ai: aiRef.current } }),
}))

const getProviderModelMock = jest.fn((_opts: unknown) => ({ provider: "anthropic" }))
jest.mock("@cognia/provider-core/core/client", () => ({
  getProviderModel: (opts: unknown) => getProviderModelMock(opts),
}))

jest.mock("@/lib/ai/provider-consumption", () => ({
  createFeatureProviderModel: () => ({ provider: "feature" }),
}))

const resolveStandaloneProviderMock = jest.fn(
  () => ({ kind: "unresolved" }) as { kind: string; protocol?: string }
)
jest.mock("@/lib/ai/chat/resolve-standalone-provider", () => ({
  resolveStandaloneProvider: () => resolveStandaloneProviderMock(),
}))

jest.mock("@/lib/runtime/streaming-fetch", () => ({
  getStreamingFetch: () => undefined,
  browserDirectHeaders: () => ({}),
}))

jest.mock("@cognia/logging", () => ({
  loggers: { canvas: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } },
}))

import {
  useCanvasSuggestions,
  normalizeConfidence,
  sliceContextWindow,
} from "./use-canvas-suggestions"

beforeEach(() => {
  generateTextMock.mockReset()
  addSuggestionMock.mockClear()
  getProviderModelMock.mockClear()
  resolveStandaloneProviderMock.mockReturnValue({ kind: "unresolved" })
  settingsRef.current = { apiKey: "k" }
  aiRef.current = { maxSuggestions: 5, contextLines: 50, suggestionProvider: "default" }
})

describe("useCanvasSuggestions", () => {
  it("parses valid suggestion JSON and stores them", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify({
        suggestions: [
          {
            type: "improve",
            explanation: "rename",
            originalText: "x",
            suggestedText: "y",
            startLine: 1,
            endLine: 1,
          },
        ],
      }),
    })
    const { result } = renderHook(() => useCanvasSuggestions())
    let suggestions: unknown[] = []
    await act(async () => {
      suggestions = await result.current.generate({
        documentId: "doc",
        language: "ts",
        content: "code",
      })
    })
    expect(suggestions).toHaveLength(1)
    expect(addSuggestionMock).toHaveBeenCalledWith("doc", expect.any(Object))
  })

  it("returns [] when JSON parsing fails", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "not json {" })
    const { result } = renderHook(() => useCanvasSuggestions())
    let suggestions: unknown[] = []
    await act(async () => {
      suggestions = await result.current.generate({
        documentId: "doc",
        language: "ts",
        content: "code",
      })
    })
    expect(suggestions).toEqual([])
  })

  it("returns [] when response has no JSON object", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "no braces here" })
    const { result } = renderHook(() => useCanvasSuggestions())
    let suggestions: unknown[] = []
    await act(async () => {
      suggestions = await result.current.generate({
        documentId: "doc",
        language: "ts",
        content: "code",
      })
    })
    expect(suggestions).toEqual([])
  })

  it("filters out invalid suggestion entries", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify({
        suggestions: [
          { suggestedText: "x" }, // missing originalText etc.
          {
            originalText: "a",
            suggestedText: "b",
            startLine: 1,
            endLine: 1,
          },
        ],
      }),
    })
    const { result } = renderHook(() => useCanvasSuggestions())
    let suggestions: unknown[] = []
    await act(async () => {
      suggestions = await result.current.generate({
        documentId: "doc",
        language: "ts",
        content: "x",
      })
    })
    expect(suggestions).toHaveLength(1)
  })

  it("respects maxSuggestions option", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify({
        suggestions: Array.from({ length: 4 }, (_, i) => ({
          originalText: `${i}`,
          suggestedText: `${i}-new`,
          startLine: i,
          endLine: i,
        })),
      }),
    })
    const { result } = renderHook(() => useCanvasSuggestions())
    let suggestions: unknown[] = []
    await act(async () => {
      suggestions = await result.current.generate(
        { documentId: "doc", language: "ts", content: "x" },
        { maxSuggestions: 2 }
      )
    })
    expect(suggestions).toHaveLength(2)
  })

  it("returns [] and logs when braced content is not valid JSON", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "{ not: valid, json }" })
    const { result } = renderHook(() => useCanvasSuggestions())
    let suggestions: unknown[] = []
    await act(async () => {
      suggestions = await result.current.generate({
        documentId: "doc",
        language: "ts",
        content: "x",
      })
    })
    expect(suggestions).toEqual([])
  })

  it("trims the prompt to a context window around the caret", async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"suggestions":[]}' })
    const content = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n")
    const { result } = renderHook(() => useCanvasSuggestions())
    await act(async () => {
      await result.current.generate(
        { documentId: "doc", language: "ts", content, cursorLine: 50 },
        { contextLines: 3 }
      )
    })
    const prompt = generateTextMock.mock.calls[0][0].prompt as string
    expect(prompt).toContain("line-50")
    expect(prompt).not.toContain("line-1\n") // far-away lines are trimmed out
  })

  it("routes to the custom OpenAI-compatible endpoint when configured", async () => {
    aiRef.current = {
      maxSuggestions: 5,
      contextLines: 50,
      suggestionProvider: "custom",
      customProviderUrl: "https://gateway.example/v1",
    }
    generateTextMock.mockResolvedValueOnce({ text: '{"suggestions":[]}' })
    const { result } = renderHook(() => useCanvasSuggestions())
    await act(async () => {
      await result.current.generate({ documentId: "doc", language: "ts", content: "x" })
    })
    expect(getProviderModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", baseURL: "https://gateway.example/v1" })
    )
  })

  it("uses the resolved app provider when standalone resolution succeeds", async () => {
    resolveStandaloneProviderMock.mockReturnValue({ kind: "resolved", protocol: "anthropic" })
    generateTextMock.mockResolvedValueOnce({ text: '{"suggestions":[]}' })
    const { result } = renderHook(() => useCanvasSuggestions())
    await act(async () => {
      await result.current.generate({ documentId: "doc", language: "ts", content: "x" })
    })
    // Resolved path uses createFeatureProviderModel, not the legacy getProviderModel.
    expect(getProviderModelMock).not.toHaveBeenCalled()
  })

  it("captures errors and returns []", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("api dead"))
    const { result } = renderHook(() => useCanvasSuggestions())
    let suggestions: unknown[] = []
    await act(async () => {
      suggestions = await result.current.generate({
        documentId: "doc",
        language: "ts",
        content: "x",
      })
    })
    expect(suggestions).toEqual([])
    expect(result.current.error).toBe("api dead")
  })

  it("carries a scope block derived from the FULL document, not the window", async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"suggestions":[]}' })
    // The declaration sits far outside the ±2-line caret window, so the only
    // way the model can learn the caret is inside `fetchUser` is the block.
    const content = [
      "export function fetchUser(id) {",
      ...Array.from({ length: 40 }, (_, i) => `  const step${i} = ${i}`),
      "  return id",
      "}",
    ].join("\n")
    const { result } = renderHook(() => useCanvasSuggestions())
    await act(async () => {
      await result.current.generate(
        { documentId: "doc", language: "typescript", content, cursorLine: 30 },
        { contextLines: 2 }
      )
    })
    const prompt = generateTextMock.mock.calls[0][0].prompt as string
    expect(prompt).toContain("Nearby scope:")
    expect(prompt).toContain("fetchUser")
    expect(prompt).not.toContain("export function fetchUser(id) {")
  })

  it("omits the scope block rather than emitting an empty one", async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"suggestions":[]}' })
    const { result } = renderHook(() => useCanvasSuggestions())
    await act(async () => {
      await result.current.generate({ documentId: "doc", language: "ts", content: "   " })
    })
    expect(generateTextMock.mock.calls[0][0].prompt as string).not.toContain("Nearby scope:")
  })

  it("still trips the PII gate when the leak is only reachable via the scope block", async () => {
    // The caret window is clean; the import line carrying the address is not.
    // The gate reads the assembled prompt, so it must still catch this.
    const content = [
      "import { mail } from 'jane@example.com/pkg'",
      ...Array.from({ length: 40 }, (_, i) => `const step${i} = ${i}`),
    ].join("\n")
    const { result } = renderHook(() => useCanvasSuggestions())
    let suggestions: unknown[] = []
    await act(async () => {
      suggestions = await result.current.generate(
        { documentId: "doc", language: "typescript", content, cursorLine: 35 },
        { contextLines: 2 }
      )
    })
    expect(suggestions).toEqual([])
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(result.current.error).toContain("PII gate")
  })

  it("blocks provider dispatch when the suggestion prompt contains PII", async () => {
    const { result } = renderHook(() => useCanvasSuggestions())
    let suggestions: unknown[] = []
    await act(async () => {
      suggestions = await result.current.generate({
        documentId: "doc",
        language: "ts",
        content: "Contact jane@example.com",
      })
    })

    expect(suggestions).toEqual([])
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(result.current.error).toContain("PII gate")
  })
})

describe("sliceContextWindow", () => {
  const doc = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n")

  it("returns the full document when contextLines is not positive", () => {
    expect(sliceContextWindow(doc, 5, 0)).toBe(doc)
    expect(sliceContextWindow(doc, 5, undefined)).toBe(doc)
  })

  it("returns the full document when it already fits the window", () => {
    expect(sliceContextWindow("a\nb\nc", 2, 5)).toBe("a\nb\nc")
  })

  it("windows ±contextLines around the caret line", () => {
    const out = sliceContextWindow(doc, 10, 2)
    expect(out).toBe("L8\nL9\nL10\nL11\nL12")
  })

  it("clamps the window at the document start when the caret is near line 1", () => {
    const out = sliceContextWindow(doc, 1, 2)
    expect(out).toBe("L1\nL2\nL3")
  })
})

describe("normalizeConfidence", () => {
  // Settings → Canvas → AI → "Show confidence" had nothing to show because no
  // suggestion carried a number. The badge is only worth rendering when the
  // value is usable — a made-up one is worse than none.
  it("accepts a 0-1 fraction", () => {
    expect(normalizeConfidence(0)).toBe(0)
    expect(normalizeConfidence(0.82)).toBe(0.82)
    expect(normalizeConfidence(1)).toBe(1)
  })

  it("normalises a percentage the model answered with", () => {
    expect(normalizeConfidence(85)).toBeCloseTo(0.85)
    expect(normalizeConfidence("85%")).toBeCloseTo(0.85)
  })

  it("discards anything that is not a usable number", () => {
    expect(normalizeConfidence(undefined)).toBeUndefined()
    expect(normalizeConfidence(null)).toBeUndefined()
    expect(normalizeConfidence("high")).toBeUndefined()
    expect(normalizeConfidence(-1)).toBeUndefined()
    expect(normalizeConfidence(101)).toBeUndefined()
    expect(normalizeConfidence(Number.NaN)).toBeUndefined()
    expect(normalizeConfidence(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})
