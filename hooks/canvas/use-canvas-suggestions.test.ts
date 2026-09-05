/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

// The generator asks for a schema-validated object now, not free text it has to
// fish JSON out of. The SDK is what enforces the schema, so the mock stands in
// for a provider that answered in shape.
const generateObjectMock = jest.fn()
jest.mock("ai", () => ({
  generateObject: (args: unknown) => generateObjectMock(args),
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
  toCanvasSuggestions,
} from "./use-canvas-suggestions"

beforeEach(() => {
  generateObjectMock.mockReset()
  addSuggestionMock.mockClear()
  getProviderModelMock.mockClear()
  resolveStandaloneProviderMock.mockReturnValue({ kind: "unresolved" })
  settingsRef.current = { apiKey: "k" }
  aiRef.current = { maxSuggestions: 5, contextLines: 50, suggestionProvider: "default" }
})

describe("useCanvasSuggestions", () => {
  it("stores the validated suggestions", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
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
      },
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

  it("respects maxSuggestions option", async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        suggestions: Array.from({ length: 4 }, (_, i) => ({
          type: "improve",
          explanation: "e",
          originalText: `${i}`,
          suggestedText: `${i}-new`,
          startLine: i + 1,
          endLine: i + 1,
        })),
      },
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

  it("trims the prompt to a context window around the caret", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { suggestions: [] } })
    const content = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n")
    const { result } = renderHook(() => useCanvasSuggestions())
    await act(async () => {
      await result.current.generate(
        { documentId: "doc", language: "ts", content, cursorLine: 50 },
        { contextLines: 3 }
      )
    })
    const prompt = generateObjectMock.mock.calls[0][0].prompt as string
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
    generateObjectMock.mockResolvedValueOnce({ object: { suggestions: [] } })
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
    generateObjectMock.mockResolvedValueOnce({ object: { suggestions: [] } })
    const { result } = renderHook(() => useCanvasSuggestions())
    await act(async () => {
      await result.current.generate({ documentId: "doc", language: "ts", content: "x" })
    })
    // Resolved path uses createFeatureProviderModel, not the legacy getProviderModel.
    expect(getProviderModelMock).not.toHaveBeenCalled()
  })

  it("captures errors and returns []", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("api dead"))
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
    generateObjectMock.mockResolvedValueOnce({ object: { suggestions: [] } })
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
    const prompt = generateObjectMock.mock.calls[0][0].prompt as string
    expect(prompt).toContain("Nearby scope:")
    expect(prompt).toContain("fetchUser")
    expect(prompt).not.toContain("export function fetchUser(id) {")
  })

  it("omits the scope block rather than emitting an empty one", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { suggestions: [] } })
    const { result } = renderHook(() => useCanvasSuggestions())
    await act(async () => {
      await result.current.generate({ documentId: "doc", language: "ts", content: "   " })
    })
    expect(generateObjectMock.mock.calls[0][0].prompt as string).not.toContain("Nearby scope:")
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
    expect(generateObjectMock).not.toHaveBeenCalled()
    expect(result.current.error).toContain("PII gate")
  })

  it("asks for the whole document in review mode, not the caret window", async () => {
    // A review that only sees 3 lines around the caret is not a review.
    generateObjectMock.mockResolvedValueOnce({ object: { suggestions: [] } })
    const content = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n")
    const { result } = renderHook(() => useCanvasSuggestions())
    await act(async () => {
      await result.current.generate(
        { documentId: "doc", language: "ts", content, cursorLine: 50 },
        { contextLines: 3, mode: "review" }
      )
    })
    const call = generateObjectMock.mock.calls[0][0]
    expect(call.prompt as string).toContain("line-1\n")
    expect(call.prompt as string).toContain("line-100")
    expect(call.system as string).toContain("meticulous reviewer")
  })

  it("uses the assist prompt by default", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { suggestions: [] } })
    const { result } = renderHook(() => useCanvasSuggestions())
    await act(async () => {
      await result.current.generate({ documentId: "doc", language: "ts", content: "x" })
    })
    expect(generateObjectMock.mock.calls[0][0].system as string).toContain(
      "expert code/text editing assistant"
    )
  })

  it("forwards an abort signal so a long review can be cancelled", async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { suggestions: [] } })
    const controller = new AbortController()
    const { result } = renderHook(() => useCanvasSuggestions())
    await act(async () => {
      await result.current.generate(
        { documentId: "doc", language: "ts", content: "x" },
        { abortSignal: controller.signal }
      )
    })
    expect(generateObjectMock.mock.calls[0][0].abortSignal).toBe(controller.signal)
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
    expect(generateObjectMock).not.toHaveBeenCalled()
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

describe("toCanvasSuggestions", () => {
  function make(overrides: Record<string, unknown> = {}) {
    return {
      suggestions: [
        {
          type: "fix" as const,
          explanation: "e",
          originalText: "a",
          suggestedText: "b",
          startLine: 3,
          endLine: 5,
          ...overrides,
        },
      ],
    }
  }

  it("maps a validated entry onto the store shape", () => {
    const [row] = toCanvasSuggestions(make(), 5)
    expect(row).toMatchObject({
      type: "fix",
      explanation: "e",
      originalText: "a",
      suggestedText: "b",
      range: { startLine: 3, endLine: 5 },
      status: "pending",
    })
  })

  it("repairs an inverted line range instead of anchoring to nothing", () => {
    // The schema can guarantee both are integers; it cannot guarantee the model
    // put them in order.
    const [row] = toCanvasSuggestions(make({ startLine: 9, endLine: 4 }), 5)
    expect(row.range).toEqual({ startLine: 4, endLine: 9 })
  })

  it("clamps a zero or negative start line to the first line", () => {
    const [row] = toCanvasSuggestions(make({ startLine: 0, endLine: 0 }), 5)
    expect(row.range).toEqual({ startLine: 1, endLine: 1 })
  })

  it("caps the list at the requested maximum", () => {
    const many = {
      suggestions: Array.from({ length: 6 }, (_, i) => ({
        type: "improve" as const,
        explanation: "e",
        originalText: `${i}`,
        suggestedText: `${i}!`,
        startLine: i + 1,
        endLine: i + 1,
      })),
    }
    expect(toCanvasSuggestions(many, 2)).toHaveLength(2)
  })

  it("omits confidence entirely when the model gave none", () => {
    const [row] = toCanvasSuggestions(make(), 5)
    expect(row).not.toHaveProperty("confidence")
  })

  it("keeps a usable confidence", () => {
    const [row] = toCanvasSuggestions(make({ confidence: 0.7 }), 5)
    expect(row.confidence).toBe(0.7)
  })
})
