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

jest.mock("@/lib/ai/generation/canvas-actions", () => ({
  ACTION_PROMPTS: {
    improve: "improve-prompt",
    custom: "custom-prompt",
  },
  buildActionUserPrompt: (req: { content: string }) => `user:${req.content}`,
}))

const getProviderModelMock = jest.fn((..._a: unknown[]) => ({ provider: "anthropic" }))
jest.mock("@/lib/ai/core/client", () => ({
  getProviderModel: (...a: unknown[]) => getProviderModelMock(...a),
}))

const settingsRef = { current: { apiKey: "k" } as { apiKey?: string } | null }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T>(selector: (s: { settings: typeof settingsRef.current }) => T): T =>
    selector({ settings: settingsRef.current }),
}))

jest.mock("@/lib/logger", () => ({
  loggers: { canvas: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } },
}))

import { useCanvasActions } from "./use-canvas-actions"

beforeEach(() => {
  generateTextMock.mockReset()
  streamTextMock.mockReset()
  getProviderModelMock.mockReset().mockReturnValue({ provider: "anthropic" })
  settingsRef.current = { apiKey: "k" }
})

describe("useCanvasActions", () => {
  it("initial state", () => {
    const { result } = renderHook(() => useCanvasActions())
    expect(result.current.running).toBe(false)
    expect(result.current.actionType).toBeNull()
    expect(result.current.output).toBe("")
    expect(result.current.error).toBeNull()
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

  it("run() falls back to ACTION_PROMPTS.custom for unknown action types", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "custom-out" })
    const { result } = renderHook(() => useCanvasActions())
    await act(async () => {
      await result.current.run({
        actionType: "unknown" as never,
        content: "x",
      })
    })
    const args = generateTextMock.mock.calls[0][0]
    expect(args.system).toBe("custom-prompt")
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

  it("reset() returns to the initial state", () => {
    const { result } = renderHook(() => useCanvasActions())
    act(() => result.current.reset())
    expect(result.current.output).toBe("")
    expect(result.current.error).toBeNull()
  })
})
