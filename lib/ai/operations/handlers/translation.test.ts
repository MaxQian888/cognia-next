/** @jest-environment node */
jest.mock("./http", () => ({ ...jest.requireActual("./http"), providerUpload: jest.fn() }))
const http = jest.requireMock("./http") as { providerUpload: jest.Mock }

import { translationCreateOutput } from "@cognia/provider-types"
import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { ProviderOperationHandlerRegistry } from "../registry"
import { TRANSLATION_HANDLERS, audioFilenameOf } from "./translation"

const provider: ResolvedProvider = {
  kind: "resolved",
  providerId: "groq",
  protocol: "openai",
  apiKey: "k",
  baseURL: "https://api.groq.com/openai/v1",
  model: undefined,
  isCustomProvider: false,
  useProxy: false,
}
const registry = new ProviderOperationHandlerRegistry()
for (const handler of TRANSLATION_HANDLERS) registry.register(handler)

describe("translation.create", () => {
  beforeEach(() => jest.clearAllMocks())

  it("names the upload by its audio type", () => {
    expect(audioFilenameOf("audio/mpeg")).toBe("audio.mp3")
    expect(audioFilenameOf("audio/x-wav")).toBe("audio.wav")
    expect(audioFilenameOf("audio/webm;codecs=opus")).toBe("audio.webm")
  })

  it("posts the audio to /audio/translations as verbose json and maps the segments", async () => {
    http.providerUpload.mockResolvedValueOnce({
      json: {
        text: "hello",
        language: "english",
        segments: [{ start: 0, end: 1.2, text: "hello" }],
      },
    })
    const output = await registry.resolve("translation.create", "groq", "openai")!.handler({
      descriptor: getProviderOperationDescriptor("translation.create")!,
      provider,
      settings: { defaultProvider: undefined, providers: {}, customProviders: [] },
      request: {
        operationId: "translation.create",
        scopes: ["provider:invoke"],
        surface: "sidecar",
        input: {
          model: "whisper-large-v3",
          audio: { base64: "AAAA", mimeType: "audio/mpeg" },
          extra: { prompt: "names" },
        },
      },
    })
    expect(translationCreateOutput.parse(output)).toEqual({
      text: "hello",
      language: "english",
      segments: [{ start: 0, end: 1.2, text: "hello" }],
    })
    const call = http.providerUpload.mock.calls[0]
    expect(call[0]).toBe(provider)
    expect(call[1].path).toBe("audio/translations")
    const form = call[1].form as FormData
    expect(form.get("model")).toBe("whisper-large-v3")
    expect(form.get("response_format")).toBe("verbose_json")
    expect(form.get("prompt")).toBe("names")
    expect((form.get("file") as File).name).toBe("audio.mp3")
    expect(registry.resolve("translation.create", "anthropic", "anthropic")).toBeUndefined()
  })
})
