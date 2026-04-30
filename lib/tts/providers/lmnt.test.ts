jest.mock("@/lib/tts/proxy-fetch", () => ({ proxyFetch: jest.fn() }))

import { proxyFetch } from "@/lib/tts/proxy-fetch"
import { generateLMNTTTS } from "./lmnt"

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

describe("generateLMNTTTS", () => {
  it("requires an API key", async () => {
    const r = await generateLMNTTTS("hi", { apiKey: "" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/API key is required/)
  })

  it("rejects oversized text", async () => {
    const r = await generateLMNTTTS("x".repeat(3001), { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/maximum length/i)
  })

  it("posts to /v1/ai/speech/bytes with default voice and clamped speed", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    const r = await generateLMNTTTS("hi", { apiKey: "k", speed: 5 })
    expect(r.success).toBe(true)
    const [url, init] = mockProxy.mock.calls[0]
    expect(url).toBe("https://api.lmnt.com/v1/ai/speech/bytes")
    expect(init.headers["X-API-Key"]).toBe("k")
    expect(init.json).toEqual({
      text: "hi",
      voice: "lily",
      speed: 2.0, // clamped
      format: "mp3",
      language: "auto",
      sample_rate: 24000,
    })
  })

  it("clamps speed below the floor", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    await generateLMNTTTS("hi", { apiKey: "k", speed: 0.1 })
    expect(mockProxy.mock.calls[0][1].json.speed).toBe(0.5)
  })

  it("returns audio/wav when format is wav", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    const r = await generateLMNTTTS("hi", { apiKey: "k", format: "wav" })
    expect(r.mimeType).toBe("audio/wav")
  })

  it("returns an api-error on a non-2xx response", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => ({ error: "no key" }),
    })
    const r = await generateLMNTTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("returns an api-error when error JSON parse fails", async () => {
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
    const r = await generateLMNTTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("wraps thrown error", async () => {
    mockProxy.mockRejectedValueOnce(new Error("dns"))
    const r = await generateLMNTTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("handles non-Error throws", async () => {
    mockProxy.mockRejectedValueOnce({})
    const r = await generateLMNTTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })
})
