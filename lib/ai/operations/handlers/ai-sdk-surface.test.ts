jest.mock("ai", () => ({
  embed: jest.fn(async () => ({ embedding: [1] })),
  embedMany: jest.fn(async () => ({ embeddings: [[1]] })),
  rerank: jest.fn(async () => ({ ranking: [] })),
  generateImage: jest.fn(async () => ({ images: [] })),
  generateSpeech: jest.fn(async () => ({ audio: {} })),
  experimental_transcribe: jest.fn(async () => ({ text: "" })),
  experimental_streamTranscribe: jest.fn(() => ({})),
  experimental_generateVideo: jest.fn(async () => ({ videos: [] })),
  generateText: jest.fn(async () => ({ text: "ok" })),
  streamText: jest.fn(() => ({ textStream: [] })),
  generateObject: jest.fn(async () => ({ object: {} })),
}))

import * as sdk from "ai"

import {
  abortableStreamModel,
  drainRejectionReports,
  simulateWebviewRuntime,
  truncatedStreamModel,
} from "@/lib/ai/webview-stream-fixtures"
import { ProviderOperationPiiGateError } from "../failure"
import {
  embedGated,
  embedManyGated,
  generateImageGated,
  generateObjectGated,
  generateSpeechGated,
  generateTextGated,
  generateVideoGated,
  rerankGated,
  streamTextGated,
  transcribeGated,
} from "./ai-sdk-surface"

const model = {} as never
const mocked = sdk as unknown as Record<string, jest.Mock>

describe("ai-sdk-surface", () => {
  beforeEach(() => jest.clearAllMocks())

  it("forwards clean text to the SDK", async () => {
    await embedGated({ model, value: "hello" })
    await embedManyGated({ model, values: ["a", "b"] })
    await rerankGated({ model, query: "q", documents: ["d"] })
    await generateImageGated({ model, prompt: "a cat" })
    await generateSpeechGated({ model, text: "hi" })
    await generateVideoGated({ model, prompt: "a cat walking" })
    expect(mocked.embed).toHaveBeenCalledTimes(1)
    expect(mocked.embedMany).toHaveBeenCalledTimes(1)
    expect(mocked.rerank).toHaveBeenCalledTimes(1)
    expect(mocked.generateImage).toHaveBeenCalledTimes(1)
    expect(mocked.generateSpeech).toHaveBeenCalledTimes(1)
    expect(mocked.experimental_generateVideo).toHaveBeenCalledTimes(1)
  })

  it("refuses text that leaks PII before the SDK is reached", () => {
    const leak = "contact me at jane.doe@example.com"
    expect(() => embedGated({ model, value: leak })).toThrow(ProviderOperationPiiGateError)
    expect(() => embedManyGated({ model, values: ["ok", leak] })).toThrow(
      ProviderOperationPiiGateError
    )
    expect(() => rerankGated({ model, query: leak, documents: [] })).toThrow(
      ProviderOperationPiiGateError
    )
    expect(() => generateImageGated({ model, prompt: leak })).toThrow(ProviderOperationPiiGateError)
    expect(() => generateSpeechGated({ model, text: leak })).toThrow(ProviderOperationPiiGateError)
    expect(mocked.embed).not.toHaveBeenCalled()
    expect(mocked.generateImage).not.toHaveBeenCalled()
  })

  it("does not gate audio-in transcription", async () => {
    await transcribeGated({ model, audio: new Uint8Array([1]) })
    expect(mocked.experimental_transcribe).toHaveBeenCalledTimes(1)
  })

  it("gates every text leaf of a language request", async () => {
    await generateTextGated({
      model,
      messages: [{ role: "user", content: "hi" }],
      system: "be terse",
    })
    expect(mocked.generateText).toHaveBeenCalledTimes(1)
    const leak = {
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "mail jane.doe@example.com" }] }],
    }
    expect(() => generateTextGated(leak as never)).toThrow(ProviderOperationPiiGateError)
    expect(() => streamTextGated(leak as never)).toThrow(ProviderOperationPiiGateError)
    expect(() => generateObjectGated({ ...leak, schema: {} } as never)).toThrow(
      ProviderOperationPiiGateError
    )
    expect(mocked.streamText).not.toHaveBeenCalled()
  })

  // `streamTextGated` forwards the caller's whole argument object, so the
  // webview-safe telemetry default must merge with a caller's own option.
  describe("streamTextGated in the webview runtime", () => {
    const actualAi = jest.requireActual<typeof import("ai")>("ai")
    let restoreRuntime: () => void
    beforeEach(() => {
      restoreRuntime = simulateWebviewRuntime()
    })
    afterEach(() => restoreRuntime())

    it("opts telemetry out when the caller set none", () => {
      streamTextGated({ model, prompt: "hi" })
      expect(mocked.streamText).toHaveBeenCalledWith(
        expect.objectContaining({ telemetry: { isEnabled: false } })
      )
    })

    it("merges the opt-out over the caller's telemetry fields", () => {
      streamTextGated({ model, prompt: "hi", telemetry: { functionId: "op", recordInputs: false } })
      expect(mocked.streamText).toHaveBeenCalledWith(
        expect.objectContaining({
          telemetry: { functionId: "op", recordInputs: false, isEnabled: false },
        })
      )
    })

    it("keeps a caller's explicit telemetry choice", () => {
      const telemetry = { isEnabled: true, functionId: "op" }
      streamTextGated({ model, prompt: "hi", telemetry })
      expect(mocked.streamText.mock.calls[0][0].telemetry).toBe(telemetry)
    })

    describe("with the real AI SDK stream", () => {
      beforeEach(() => {
        mocked.streamText.mockImplementation(actualAi.streamText)
      })
      afterEach(() => {
        mocked.streamText.mockImplementation(() => ({ textStream: [] }))
      })

      it("surfaces a stream cut off mid-response without leaking an unhandled rejection", async () => {
        // The SDK's default `onError` logs the stream error.
        const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
        const result = streamTextGated({ model: truncatedStreamModel(), prompt: "hi" })

        let text = ""
        for await (const delta of result.textStream) text += delta
        await expect(Promise.resolve(result.finishReason)).rejects.toThrow("No output generated")
        await drainRejectionReports()

        expect(text).toBe("")
        consoleError.mockRestore()
      })

      it("surfaces a mid-stream abort without leaking an unhandled rejection", async () => {
        const abort = new AbortController()
        const result = streamTextGated({
          model: abortableStreamModel(),
          prompt: "hi",
          abortSignal: abort.signal,
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
    })
  })
})
