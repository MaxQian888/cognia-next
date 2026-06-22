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

jest.mock("@cognia/provider-core/core/client", () => ({
  getProviderModel: () => ({ provider: "anthropic" }),
}))

jest.mock("@/lib/logging", () => ({
  loggers: { canvas: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } },
}))

import { useCanvasSuggestions } from "./use-canvas-suggestions"

beforeEach(() => {
  generateTextMock.mockReset()
  addSuggestionMock.mockClear()
  settingsRef.current = { apiKey: "k" }
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
})
