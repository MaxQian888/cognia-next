jest.mock("@/lib/tts/proxy-fetch", () => ({ proxyFetch: jest.fn() }))

import { proxyFetch } from "@/lib/tts/proxy-fetch"
import { generateElevenLabsTTS } from "./elevenlabs"

const mockProxy = proxyFetch as jest.Mock

function ok() {
  return {
    ok: true,
    status: 200,
    mime: "audio/mpeg",
    bytes: new ArrayBuffer(2),
    text: async () => "",
    json: async () => ({}),
  }
}

beforeEach(() => mockProxy.mockReset())

describe("generateElevenLabsTTS", () => {
  it("requires an API key", async () => {
    const r = await generateElevenLabsTTS("hi", { apiKey: "" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/API key is required/)
  })

  it("rejects oversized text", async () => {
    const r = await generateElevenLabsTTS("x".repeat(5001), { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/maximum length/i)
  })

  it("posts to /v1/text-to-speech/<voice> with xi-api-key", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    const r = await generateElevenLabsTTS("hi", {
      apiKey: "k",
      voice: "rachel",
      stability: 0.3,
      similarityBoost: 0.4,
    })
    expect(r.success).toBe(true)
    expect(r.mimeType).toBe("audio/mpeg")
    const [url, init] = mockProxy.mock.calls[0]
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/rachel")
    expect(init.headers["xi-api-key"]).toBe("k")
    expect(init.headers.Accept).toBe("audio/mpeg")
    expect(init.json).toEqual({
      text: "hi",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.3, similarity_boost: 0.4 },
    })
  })

  it("returns an api-error on a non-2xx response", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 422,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => ({ detail: { message: "validation failed" } }),
    })
    const r = await generateElevenLabsTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("returns an api-error when JSON parse fails", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 502,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => {
        throw new Error("bad")
      },
    })
    const r = await generateElevenLabsTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("returns an api-error on thrown Error", async () => {
    mockProxy.mockRejectedValueOnce(new Error("eof"))
    const r = await generateElevenLabsTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("handles non-Error throws", async () => {
    mockProxy.mockRejectedValueOnce(null)
    const r = await generateElevenLabsTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })
})
