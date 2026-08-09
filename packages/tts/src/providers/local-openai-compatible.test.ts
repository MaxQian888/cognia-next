jest.mock("../proxy-fetch", () => ({ proxyFetch: jest.fn() }))

import { proxyFetch } from "../proxy-fetch"
import { generateLocalOpenAICompatibleTTS } from "./local-openai-compatible"

const mockProxy = proxyFetch as jest.Mock

function response(mime = "audio/mpeg; charset=binary") {
  return {
    ok: true,
    status: 200,
    mime,
    bytes: new ArrayBuffer(2),
    text: async () => "",
    json: async () => ({}),
  }
}

beforeEach(() => mockProxy.mockReset())

describe("generateLocalOpenAICompatibleTTS", () => {
  it("requires a configured endpoint, model, and voice", async () => {
    await expect(
      generateLocalOpenAICompatibleTTS("hello", {
        baseUrl: "",
        model: "model",
        voice: "voice",
      })
    ).resolves.toMatchObject({ success: false, errorType: "not-supported" })
  })

  it.each([
    "http://192.168.1.20:8080/v1",
    "http://169.254.169.254/latest",
    "https://example.com/v1",
    "ftp://localhost/v1",
  ])("rejects non-loopback endpoint %s before transport", async (baseUrl) => {
    const result = await generateLocalOpenAICompatibleTTS("hello", {
      baseUrl,
      model: "kokoro",
      voice: "af_heart",
    })

    expect(result).toMatchObject({ success: false, errorType: "not-supported" })
    expect(mockProxy).not.toHaveBeenCalled()
  })

  it("posts the OpenAI speech shape to a normalized endpoint", async () => {
    mockProxy.mockResolvedValueOnce(response())
    const controller = new AbortController()

    const result = await generateLocalOpenAICompatibleTTS("hello", {
      baseUrl: "http://127.0.0.1:8080/v1/",
      model: "kokoro",
      voice: "af_heart",
      speed: 1.25,
      responseFormat: "mp3",
      timeoutMs: 1234,
      apiKey: "optional",
      signal: controller.signal,
      requestId: "request-1",
    })

    expect(result).toMatchObject({ success: true, mimeType: "audio/mpeg" })
    expect(mockProxy).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1/audio/speech",
      expect.objectContaining({
        provider: "local-openai-compatible",
        requestId: "request-1",
        signal: controller.signal,
        timeoutMs: 1234,
        json: {
          model: "kokoro",
          input: "hello",
          voice: "af_heart",
          speed: 1.25,
          response_format: "mp3",
        },
      })
    )
    expect(mockProxy.mock.calls[0][1].headers.Authorization).toBe("Bearer optional")
  })

  it("does not send an authorization header when no optional key is configured", async () => {
    mockProxy.mockResolvedValueOnce(response("application/octet-stream"))
    const result = await generateLocalOpenAICompatibleTTS("hello", {
      baseUrl: "http://localhost:8880/v1",
      model: "kokoro",
      voice: "af_heart",
      responseFormat: "wav",
    })

    expect(mockProxy.mock.calls[0][1].headers.Authorization).toBeUndefined()
    expect(result.mimeType).toBe("audio/wav")
  })

  it("rejects unexpected headerless PCM instead of handing it to Audio", async () => {
    mockProxy.mockResolvedValueOnce(response("audio/pcm; rate=24000"))
    const result = await generateLocalOpenAICompatibleTTS("hello", {
      baseUrl: "http://localhost:8880/v1",
      model: "kokoro",
      voice: "af_heart",
    })

    expect(result).toMatchObject({ success: false, errorType: "not-supported" })
  })
})
