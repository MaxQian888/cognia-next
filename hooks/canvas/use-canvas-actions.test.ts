/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const generateTextMock = jest.fn()
const streamTextMock = jest.fn()
jest.mock("ai", () => ({
  generateText: (args: unknown) => generateTextMock(args),
  streamText: (args: unknown) => streamTextMock(args),
}))

// `@/lib/ai/generation/canvas-actions` is deliberately NOT mocked: it is the
// single prompt builder and PII gate this hook was consolidated onto, and
// stubbing it would test the seam instead of the behaviour.

const canvasSettingsRef = { current: { ai: { streamingResponses: false } } }
jest.mock("@/stores/canvas/canvas-settings-store", () => ({
  useCanvasSettingsStore: <T>(
    selector: (s: { settings: typeof canvasSettingsRef.current }) => T
  ): T => selector({ settings: canvasSettingsRef.current }),
}))

const getProviderModelMock = jest.fn((..._a: unknown[]) => ({ provider: "anthropic" }))
jest.mock("@cognia/provider-core/core/client", () => ({
  getProviderModel: (...a: unknown[]) => getProviderModelMock(...a),
}))

const settingsRef = { current: { apiKey: "k" } as { apiKey?: string } | null }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T>(selector: (s: { settings: typeof settingsRef.current }) => T): T =>
    selector({ settings: settingsRef.current }),
}))

jest.mock("@cognia/logging", () => ({
  loggers: { canvas: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } },
}))

import { useCanvasActions } from "./use-canvas-actions"

beforeEach(() => {
  generateTextMock.mockReset()
  streamTextMock.mockReset()
  getProviderModelMock.mockReset().mockReturnValue({ provider: "anthropic" })
  settingsRef.current = { apiKey: "k" }
  canvasSettingsRef.current = { ai: { streamingResponses: false } }
})

describe("useCanvasActions", () => {
  it("initial state", () => {
    const { result } = renderHook(() => useCanvasActions())
    expect(result.current.running).toBe(false)
    expect(result.current.actionType).toBeNull()
    expect(result.current.output).toBe("")
    expect(result.current.error).toBeNull()
    expect(result.current.errorKind).toBeNull()
    expect(result.current.cancellable).toBe(false)
    expect(result.current.retryable).toBe(false)
  })

  it("run() success populates output", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "improved" })
    const { result } = renderHook(() => useCanvasActions())
    let out: string | undefined
    await act(async () => {
      out = await result.current.run({
        actionType: "improve" as never,
        content: "hello",
      })
    })
    expect(out).toBe("improved")
    expect(result.current.output).toBe("improved")
  })

  it("uses the configured BYOK provider (not the legacy Anthropic path) when a key is set", async () => {
    settingsRef.current = {
      defaultProvider: "anthropic",
      providerSettings: { anthropic: { enabled: true, apiKey: "sk-ant" } },
    } as never
    generateTextMock.mockResolvedValueOnce({ text: "ok" })
    const { result } = renderHook(() => useCanvasActions())
    await act(async () => {
      await result.current.run({ actionType: "improve" as never, content: "x" })
    })
    // Resolved via provider-consumption — the legacy single-key path is skipped.
    expect(getProviderModelMock).not.toHaveBeenCalled()
    expect(generateTextMock).toHaveBeenCalled()
  })

  it("sends the shared prompt pair, attachments included", async () => {
    // The plugin path already composed attachments into the system prompt; the
    // hook did not, because it used a second builder. One builder now.
    generateTextMock.mockResolvedValueOnce({ text: "ok" })
    const { result } = renderHook(() => useCanvasActions())
    await act(async () => {
      await result.current.run({
        actionType: "improve" as never,
        content: "body",
        language: "typescript",
        prompt: "be terse",
        attachments: [
          {
            id: "a1",
            sourceType: "canvas-document",
            sourceId: "doc_2",
            label: "Notes",
            snapshot: "snapshot text",
          },
        ],
      })
    })
    const args = generateTextMock.mock.calls[0][0]
    expect(args.system).toContain("Language: typescript")
    expect(args.system).toContain("be terse")
    expect(args.system).toContain("snapshot text")
    expect(args.prompt).toBe("body")
  })

  it("uses a low temperature for the deterministic actions", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "ok" })
    const { result } = renderHook(() => useCanvasActions())
    await act(async () => {
      await result.current.run({ actionType: "format" as never, content: "x" })
    })
    expect(generateTextMock.mock.calls[0][0].temperature).toBe(0.3)
  })

  it("run() rethrows and surfaces error state", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() => useCanvasActions())
    await act(async () => {
      try {
        await result.current.run({ actionType: "improve" as never, content: "x" })
      } catch (err) {
        expect((err as Error).message).toBe("boom")
      }
    })
    expect(result.current.error).toBe("boom")
    expect(result.current.errorKind).toBe("failed")
    expect(result.current.retryable).toBe(true)
  })

  it("blocks provider dispatch when the assembled action prompt contains PII", async () => {
    const { result } = renderHook(() => useCanvasActions())

    await act(async () => {
      await expect(
        result.current.run({ actionType: "improve" as never, content: "jane@example.com" })
      ).rejects.toThrow("PII gate")
    })

    expect(generateTextMock).not.toHaveBeenCalled()
    expect(result.current.error).toContain("PII gate")
    expect(result.current.errorKind).toBe("pii-blocked")
    // A redaction refusal refuses identically next time, so a retry button here
    // would be one that always fails.
    expect(result.current.retryable).toBe(false)
  })

  it("stream() accumulates deltas and resolves with full text", async () => {
    streamTextMock.mockReturnValueOnce({
      textStream: (async function* () {
        yield "hel"
        yield "lo"
      })(),
    })
    const { result } = renderHook(() => useCanvasActions())
    const onDelta = jest.fn()
    let out: string | undefined
    await act(async () => {
      out = await result.current.stream({ actionType: "improve" as never, content: "x" }, onDelta)
    })
    expect(out).toBe("hello")
    expect(onDelta).toHaveBeenCalledTimes(2)
  })

  it("stream() rethrows and stores partial output", async () => {
    streamTextMock.mockReturnValueOnce({
      textStream: (async function* () {
        yield "p"
        throw new Error("net")
      })(),
    })
    const { result } = renderHook(() => useCanvasActions())
    await act(async () => {
      try {
        await result.current.stream({ actionType: "improve" as never, content: "x" }, jest.fn())
      } catch (err) {
        expect((err as Error).message).toBe("net")
      }
    })
    expect(result.current.error).toBe("net")
    expect(result.current.output).toBe("p")
  })

  it("blocks streaming dispatch when the assembled action prompt contains PII", async () => {
    const { result } = renderHook(() => useCanvasActions())

    await act(async () => {
      await expect(
        result.current.stream(
          { actionType: "improve" as never, content: "jane@example.com" },
          jest.fn()
        )
      ).rejects.toThrow("PII gate")
    })

    expect(streamTextMock).not.toHaveBeenCalled()
  })

  it("reset() returns to the initial state", () => {
    const { result } = renderHook(() => useCanvasActions())
    act(() => result.current.reset())
    expect(result.current.output).toBe("")
    expect(result.current.error).toBeNull()
  })

  it("streams without a delta callback when the setting asks for it", async () => {
    // Settings, Canvas, AI, "Stream responses" had no runtime consumer at all.
    canvasSettingsRef.current = { ai: { streamingResponses: true } }
    streamTextMock.mockReturnValueOnce({
      textStream: (async function* () {
        yield "a"
        yield "b"
      })(),
    })
    const { result } = renderHook(() => useCanvasActions())
    await act(async () => {
      await result.current.run({ actionType: "improve" as never, content: "x" })
    })
    expect(streamTextMock).toHaveBeenCalled()
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(result.current.output).toBe("ab")
  })

  it("hands the provider a real abort signal, and cancel() aborts it", async () => {
    let seenSignal: AbortSignal | undefined
    generateTextMock.mockImplementationOnce(
      (args: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          seenSignal = args.abortSignal
          args.abortSignal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          )
        })
    )
    const { result } = renderHook(() => useCanvasActions())

    let pending: Promise<string> | undefined
    act(() => {
      pending = result.current.run({ actionType: "improve" as never, content: "x" })
      pending.catch(() => undefined)
    })
    expect(result.current.cancellable).toBe(true)
    expect(seenSignal).toBeInstanceOf(AbortSignal)

    await act(async () => {
      result.current.cancel()
      await expect(pending).rejects.toThrow()
    })

    expect(result.current.errorKind).toBe("cancelled")
    expect(result.current.running).toBe(false)
    // A cancellation is a user decision, so it offers no retry.
    expect(result.current.retryable).toBe(false)
  })

  it("retry() replays the last invocation verbatim", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("flaky"))
    generateTextMock.mockResolvedValueOnce({ text: "second time" })
    const { result } = renderHook(() => useCanvasActions())

    await act(async () => {
      await result.current
        .run({ actionType: "improve" as never, content: "body", language: "python" })
        .catch(() => undefined)
    })
    expect(result.current.retryable).toBe(true)

    await act(async () => {
      await result.current.retry()
    })

    expect(result.current.output).toBe("second time")
    expect(generateTextMock).toHaveBeenCalledTimes(2)
    expect(generateTextMock.mock.calls[1][0].prompt).toBe(generateTextMock.mock.calls[0][0].prompt)
  })

  it("retry() is a no-op before anything has run", async () => {
    const { result } = renderHook(() => useCanvasActions())
    await act(async () => {
      await expect(result.current.retry()).resolves.toBe("")
    })
    expect(generateTextMock).not.toHaveBeenCalled()
  })

  it("aborts an in-flight run when the hook unmounts", async () => {
    let seenSignal: AbortSignal | undefined
    generateTextMock.mockImplementationOnce(
      (args: { abortSignal?: AbortSignal }) =>
        new Promise(() => {
          seenSignal = args.abortSignal
        })
    )
    const { result, unmount } = renderHook(() => useCanvasActions())
    act(() => {
      result.current.run({ actionType: "improve" as never, content: "x" }).catch(() => undefined)
    })

    unmount()
    expect(seenSignal?.aborted).toBe(true)
  })
})
