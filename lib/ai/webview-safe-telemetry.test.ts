import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { APICallError, registerTelemetry, streamText, type TelemetryOptions } from "ai"
import { MockLanguageModelV4 } from "ai/test"

import { webviewSafeTelemetry } from "./webview-safe-telemetry"
import {
  abortableStreamModel,
  completedStreamModel,
  drainRejectionReports,
  simulateWebviewRuntime,
  truncatedStreamModel,
} from "./webview-stream-fixtures"

afterEach(() => {
  globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined
})

describe("webviewSafeTelemetry on Node", () => {
  it("passes an absent option through so the SDK keeps its Node defaults", () => {
    expect(webviewSafeTelemetry()).toBeUndefined()
  })

  it("passes a caller's option through untouched", () => {
    const telemetry: TelemetryOptions = { functionId: "canvas" }
    expect(webviewSafeTelemetry(telemetry)).toBe(telemetry)
  })
})

describe("webviewSafeTelemetry in the webview", () => {
  let restoreRuntime: () => void
  beforeEach(() => {
    restoreRuntime = simulateWebviewRuntime()
  })
  afterEach(() => restoreRuntime())

  it("opts out when nothing would receive telemetry", () => {
    expect(webviewSafeTelemetry()).toEqual({ isEnabled: false })
  })

  it("merges the opt-out over the caller's other fields", () => {
    const telemetry: TelemetryOptions = { functionId: "canvas", recordInputs: false }
    expect(webviewSafeTelemetry(telemetry)).toEqual({
      functionId: "canvas",
      recordInputs: false,
      isEnabled: false,
    })
    expect(telemetry).toEqual({ functionId: "canvas", recordInputs: false })
  })

  it.each([
    ["an explicit opt-in", { isEnabled: true, functionId: "canvas" }],
    ["an explicit opt-out", { isEnabled: false, functionId: "canvas" }],
    ["per-call integrations", { integrations: [{ onStart: () => {} }] }],
  ] as Array<[string, TelemetryOptions]>)("keeps %s as the caller set it", (_label, telemetry) => {
    expect(webviewSafeTelemetry(telemetry)).toBe(telemetry)
  })

  it("keeps telemetry on while a global integration is registered", () => {
    registerTelemetry({ onStart: () => {} })
    expect(webviewSafeTelemetry()).toBeUndefined()
    const telemetry: TelemetryOptions = { functionId: "canvas" }
    expect(webviewSafeTelemetry(telemetry)).toBe(telemetry)
  })
})

// The REAL `streamText`, once per failure shape that rejects the SDK's result
// promises on this runtime. Each one leaks without the option (verified by
// swapping it out); `textStream` alone never surfaces these failures.
describe("webviewSafeTelemetry with the real streamText (webview runtime)", () => {
  let restoreRuntime: () => void
  let consoleError: jest.SpyInstance
  beforeEach(() => {
    restoreRuntime = simulateWebviewRuntime()
    // The SDK's default `onError` logs every stream error.
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    consoleError.mockRestore()
    restoreRuntime()
  })

  async function readText(stream: AsyncIterable<string>): Promise<string> {
    let text = ""
    for await (const delta of stream) text += delta
    return text
  }

  it("absorbs a rejected request (auth, rate limit) without leaking", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: "invalid api key",
          url: "https://api.provider.test/v1/messages",
          requestBodyValues: {},
          statusCode: 401,
          isRetryable: false,
        })
      },
    })
    const result = streamText({ model, prompt: "hello", telemetry: webviewSafeTelemetry() })

    expect(await readText(result.textStream)).toBe("")
    await expect(Promise.resolve(result.finishReason)).rejects.toThrow("No output generated")
    await drainRejectionReports()
  })

  it("absorbs a response cut off before any output without leaking", async () => {
    const result = streamText({
      model: truncatedStreamModel(),
      prompt: "hello",
      telemetry: webviewSafeTelemetry(),
    })

    expect(await readText(result.textStream)).toBe("")
    await expect(Promise.resolve(result.finishReason)).rejects.toThrow("No output generated")
    await drainRejectionReports()
  })

  it("absorbs a mid-stream abort without leaking", async () => {
    const abort = new AbortController()
    const result = streamText({
      model: abortableStreamModel(),
      prompt: "hello",
      abortSignal: abort.signal,
      telemetry: webviewSafeTelemetry(),
    })

    let text = ""
    for await (const delta of result.textStream) {
      text += delta
      abort.abort()
    }
    await expect(Promise.resolve(result.totalUsage)).rejects.toBe(abort.signal.reason)
    await drainRejectionReports()

    expect(text).toBe("partial answer")
  })

  it("absorbs a dropped connection whose result promises are read, without leaking", async () => {
    // A transport error reaches `textStream` as a throw. The result promises
    // reject only once something reads them, as `language.stream` does up front.
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const parts: LanguageModelV4StreamPart[] = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "partial answer" },
        ]
        return {
          // One part per pull: erroring a stream discards whatever is queued.
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            pull(controller) {
              const next = parts.shift()
              if (next) controller.enqueue(next)
              else controller.error(new Error("connection reset"))
            },
          }),
        }
      },
    })
    const result = streamText({ model, prompt: "hello", telemetry: webviewSafeTelemetry() })
    const finishReason = Promise.resolve(result.finishReason)

    await expect(readText(result.textStream)).rejects.toThrow("connection reset")
    await expect(finishReason).rejects.toThrow("connection reset")
    await drainRejectionReports()
  })

  it("still delivers events to a registered global integration", async () => {
    // A successful stream: with telemetry left on, a failed one would leak,
    // which is the trade `webviewSafeTelemetry` documents for this case.
    const onStart = jest.fn()
    const onEnd = jest.fn()
    registerTelemetry({ onStart, onEnd })
    const result = streamText({
      model: completedStreamModel(),
      prompt: "hello",
      telemetry: webviewSafeTelemetry(),
    })

    expect(await readText(result.textStream)).toBe("full answer")
    expect(await result.finishReason).toBe("stop")
    await drainRejectionReports()

    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })
})
