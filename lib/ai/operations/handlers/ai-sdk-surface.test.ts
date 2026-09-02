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
})
