jest.mock("@/lib/tts/proxy-fetch", () => ({ proxyFetch: jest.fn() }))

import { proxyFetch } from "@/lib/tts/proxy-fetch"
import { generateGeminiTTS, pcmToWav } from "./gemini"

const mockProxy = proxyFetch as jest.Mock

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    mime: "application/json",
    bytes: new ArrayBuffer(0),
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

beforeEach(() => mockProxy.mockReset())

describe("generateGeminiTTS", () => {
  it("requires an API key", async () => {
    const r = await generateGeminiTTS("hi", { apiKey: "" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/API key is required/)
  })

  it("rejects oversized text", async () => {
    const r = await generateGeminiTTS("x".repeat(8001), { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/maximum length/i)
  })

  it("posts to generativelanguage URL with the model and api key", async () => {
    mockProxy.mockResolvedValueOnce(
      okJson({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: btoa("\x00\x01\x02"), mimeType: "audio/L16" } }],
            },
          },
        ],
      })
    )
    const r = await generateGeminiTTS("hello", { apiKey: "kkk", voice: "Kore" })
    expect(r.success).toBe(true)
    expect(r.mimeType).toBe("audio/wav")
    const [url, init] = mockProxy.mock.calls[0]
    expect(url).toContain("gemini-2.5-flash-preview-tts:generateContent?key=kkk")
    expect(init.json.contents[0].parts[0].text).toBe("hello")
    expect(init.json.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      "Kore"
    )
    // PCM gets a WAV header (44 bytes + 3 bytes data = 47).
    expect((r.audioData as ArrayBuffer).byteLength).toBe(47)
  })

  it("returns the bytes unchanged when the inline mime is not pcm", async () => {
    mockProxy.mockResolvedValueOnce(
      okJson({
        candidates: [
          {
            content: { parts: [{ inlineData: { data: btoa("abcd"), mimeType: "audio/mpeg" } }] },
          },
        ],
      })
    )
    const r = await generateGeminiTTS("hi", { apiKey: "k" })
    expect(r.mimeType).toBe("audio/mpeg")
    expect((r.audioData as ArrayBuffer).byteLength).toBe(4)
  })

  it("uses the supplied model when provided", async () => {
    mockProxy.mockResolvedValueOnce(
      okJson({
        candidates: [
          { content: { parts: [{ inlineData: { data: btoa("x"), mimeType: "audio/mpeg" } }] } },
        ],
      })
    )
    await generateGeminiTTS("hi", { apiKey: "k", model: "gemini-x-tts" })
    expect(mockProxy.mock.calls[0][0]).toContain("gemini-x-tts:generateContent")
  })

  it("returns an api-error when inlineData is missing", async () => {
    mockProxy.mockResolvedValueOnce(okJson({ candidates: [{ content: { parts: [{}] } }] }))
    const r = await generateGeminiTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("returns an api-error on a non-2xx response", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => ({ error: { message: "no auth" } }),
    })
    const r = await generateGeminiTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("returns an api-error when error JSON cannot be parsed", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => {
        throw new Error("bad")
      },
    })
    const r = await generateGeminiTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("wraps thrown error as network-error", async () => {
    mockProxy.mockRejectedValueOnce(new Error("dns"))
    const r = await generateGeminiTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Network error/)
  })

  it("handles non-Error throws", async () => {
    mockProxy.mockRejectedValueOnce("nope")
    const r = await generateGeminiTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/Network error/)
  })
})

describe("pcmToWav", () => {
  it("emits a 44-byte RIFF/WAVE header followed by the PCM data", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]).buffer
    const wav = pcmToWav(pcm, 24000, 1)
    expect(wav.byteLength).toBe(48)
    const view = new DataView(wav)
    // "RIFF"
    expect(
      String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
    ).toBe("RIFF")
    // "WAVE"
    expect(
      String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))
    ).toBe("WAVE")
    // sample rate
    expect(view.getUint32(24, true)).toBe(24000)
    // payload
    expect(view.getUint32(40, true)).toBe(4)
  })
})
