jest.mock("../proxy-fetch", () => ({ proxyFetch: jest.fn() }))

import { proxyFetch } from "../proxy-fetch"
import { generateDeepgramTTS } from "./deepgram"

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

describe("generateDeepgramTTS", () => {
  it("requires an API key", async () => {
    const r = await generateDeepgramTTS("hi", { apiKey: "" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/API key is required/)
  })

  it("rejects oversized text", async () => {
    const r = await generateDeepgramTTS("x".repeat(10001), { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/maximum length/i)
  })

  it("posts to /v1/speak with model+encoding query and Token auth", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    const r = await generateDeepgramTTS("hello", { apiKey: "k" })
    expect(r.success).toBe(true)
    const [url, init] = mockProxy.mock.calls[0]
    expect(url).toMatch(/api\.deepgram\.com\/v1\/speak\?/)
    expect(url).toContain("model=aura-2-asteria-en")
    expect(url).toContain("encoding=mp3")
    expect(init.headers.Authorization).toBe("Token k")
    expect(init.json).toEqual({ text: "hello" })
    expect(r.mimeType).toBe("audio/mpeg")
  })

  it.each([
    ["linear16", "audio/wav"],
    ["aac", "audio/aac"],
    ["opus", "audio/opus"],
    ["flac", "audio/flac"],
  ] as const)("maps encoding %s to mime %s", async (enc, mime) => {
    mockProxy.mockResolvedValueOnce(ok())
    const r = await generateDeepgramTTS("hi", { apiKey: "k", encoding: enc })
    expect(r.mimeType).toBe(mime)
    expect(mockProxy.mock.calls[0][0]).toContain(`encoding=${enc}`)
  })

  it("includes container and sample_rate when supplied", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    await generateDeepgramTTS("hi", {
      apiKey: "k",
      encoding: "linear16",
      container: "wav",
      sampleRate: 48000,
    })
    const url = mockProxy.mock.calls[0][0] as string
    expect(url).toContain("container=wav")
    expect(url).toContain("sample_rate=48000")
  })

  it("returns an api-error on a non-2xx response", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => ({ err_msg: "invalid voice" }),
    })
    const r = await generateDeepgramTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("returns an api-error when error JSON parse fails", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => {
        throw new Error("nope")
      },
    })
    const r = await generateDeepgramTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("returns an api-error on proxyFetch throw", async () => {
    mockProxy.mockRejectedValueOnce(new Error("offline"))
    const r = await generateDeepgramTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("handles non-Error throws", async () => {
    mockProxy.mockRejectedValueOnce(123)
    const r = await generateDeepgramTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })
})
