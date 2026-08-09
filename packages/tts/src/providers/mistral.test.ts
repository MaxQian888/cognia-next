import { generateMistralTTS } from "./mistral"

const proxyFetchMock = jest.fn()

jest.mock("../proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) => proxyFetchMock(...args),
}))

describe("generateMistralTTS", () => {
  beforeEach(() => proxyFetchMock.mockReset())

  it("generates Voxtral speech with the configured reusable voice", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ audio_data: "YWJj" }),
    })

    const result = await generateMistralTTS("Hello", {
      apiKey: "key",
      voiceId: "voice-123",
      model: "voxtral-mini-tts-2603",
      responseFormat: "mp3",
    })

    expect(proxyFetchMock).toHaveBeenCalledWith(
      "https://api.mistral.ai/v1/audio/speech",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer key" }),
        json: {
          input: "Hello",
          model: "voxtral-mini-tts-2603",
          voice_id: "voice-123",
          response_format: "mp3",
          stream: false,
        },
      })
    )
    expect(result).toMatchObject({ success: true, mimeType: "audio/mpeg" })
    expect(new TextDecoder().decode(result.audioData as ArrayBuffer)).toBe("abc")
  })

  it("requires both an API key and a saved voice id", async () => {
    await expect(generateMistralTTS("Hello", { apiKey: "", voiceId: "v" })).resolves.toMatchObject({
      success: false,
      errorType: "api-key-missing",
    })
    await expect(generateMistralTTS("Hello", { apiKey: "k", voiceId: "" })).resolves.toMatchObject({
      success: false,
      errorType: "voice-not-found",
    })
    expect(proxyFetchMock).not.toHaveBeenCalled()
  })

  it("preserves upstream API errors", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: "content rejected" }),
    })

    await expect(generateMistralTTS("Hello", { apiKey: "k", voiceId: "v" })).resolves.toMatchObject(
      {
        success: false,
        errorType: "api-error",
        status: 403,
        providerMessage: "content rejected",
      }
    )
  })
})

it.each([
  [{ error: { message: "nested error" } }, "nested error"],
  [{}, "Mistral API error: 500"],
])("normalizes alternate API error shapes", async (payload, providerMessage) => {
  proxyFetchMock.mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => payload,
  })
  await expect(generateMistralTTS("Hello", { apiKey: "k", voiceId: "v" })).resolves.toMatchObject({
    providerMessage,
  })
})

it("rejects text beyond the provider guidance before dispatch", async () => {
  await expect(
    generateMistralTTS("x".repeat(3001), { apiKey: "k", voiceId: "v" })
  ).resolves.toMatchObject({
    success: false,
    errorType: "text-too-long",
  })
  expect(proxyFetchMock).not.toHaveBeenCalled()
})

it("rejects successful responses that contain no audio", async () => {
  proxyFetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  })
  await expect(generateMistralTTS("Hello", { apiKey: "k", voiceId: "v" })).resolves.toMatchObject({
    success: false,
    errorType: "api-error",
    providerMessage: "No audio data in response",
  })
})

it("normalizes transport failures", async () => {
  proxyFetchMock.mockRejectedValue(new Error("offline"))
  await expect(generateMistralTTS("Hello", { apiKey: "k", voiceId: "v" })).resolves.toMatchObject({
    success: false,
    errorType: "network-error",
    providerMessage: "offline",
  })
})

it("normalizes non-Error transport failures", async () => {
  proxyFetchMock.mockRejectedValue("offline")
  await expect(generateMistralTTS("Hello", { apiKey: "k", voiceId: "v" })).resolves.toMatchObject({
    success: false,
    errorType: "network-error",
    providerMessage: "Unknown error",
  })
})

it.each([
  ["mp3", "audio/mpeg"],
  ["wav", "audio/wav"],
  ["flac", "audio/flac"],
  ["opus", "audio/opus"],
] as const)("maps %s responses to %s", async (responseFormat, mimeType) => {
  proxyFetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ audio_data: "YQ==" }),
  })
  await expect(
    generateMistralTTS("Hello", {
      apiKey: "k",
      voiceId: " v ",
      responseFormat,
    })
  ).resolves.toMatchObject({ success: true, mimeType })
})

it("rejects a legacy PCM format before making a request", async () => {
  await expect(
    generateMistralTTS("Hello", {
      apiKey: "k",
      voiceId: "v",
      responseFormat: "pcm" as never,
    })
  ).resolves.toMatchObject({ success: false, errorType: "not-supported" })
  expect(proxyFetchMock).not.toHaveBeenCalled()
})
