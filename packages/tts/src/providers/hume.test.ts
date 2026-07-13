jest.mock("../proxy-fetch", () => ({ proxyFetch: jest.fn() }))

import { proxyFetch } from "../proxy-fetch"
import { generateHumeTTS } from "./hume"

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

describe("generateHumeTTS", () => {
  it("requires an API key", async () => {
    const r = await generateHumeTTS("hi", { apiKey: "" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/API key is required/)
  })

  it("rejects oversized text", async () => {
    const r = await generateHumeTTS("x".repeat(5001), { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/maximum length/i)
  })

  it("posts utterances to /v0/tts and decodes base64 mp3 by default", async () => {
    mockProxy.mockResolvedValueOnce(
      okJson({ generations: [{ audio: btoa("abcd"), encoding: { format: "mp3" } }] })
    )
    const r = await generateHumeTTS("hello", { apiKey: "k" })
    expect(r.success).toBe(true)
    expect(r.mimeType).toBe("audio/mpeg")
    const [url, init] = mockProxy.mock.calls[0]
    expect(url).toBe("https://api.hume.ai/v0/tts")
    expect(init.headers["X-Hume-Api-Key"]).toBe("k")
    expect(init.json.utterances[0].voice).toEqual({ name: "kora" })
    expect(init.json.utterances[0].description).toBeUndefined()
    expect((r.audioData as ArrayBuffer).byteLength).toBe(4)
  })

  it("forwards actingInstructions as description", async () => {
    mockProxy.mockResolvedValueOnce(
      okJson({ generations: [{ audio: btoa("ab"), encoding: { format: "mp3" } }] })
    )
    await generateHumeTTS("hi", { apiKey: "k", actingInstructions: "warm" })
    expect(mockProxy.mock.calls[0][1].json.utterances[0].description).toBe("warm")
  })

  it.each([
    ["wav", "audio/wav"],
    ["pcm", "audio/pcm"],
    ["mp3", "audio/mpeg"],
  ] as const)("maps encoding format %s to mime %s", async (fmt, mime) => {
    mockProxy.mockResolvedValueOnce(
      okJson({ generations: [{ audio: btoa("a"), encoding: { format: fmt } }] })
    )
    const r = await generateHumeTTS("hi", { apiKey: "k" })
    expect(r.mimeType).toBe(mime)
  })

  it("defaults to mp3 mime when encoding is missing", async () => {
    mockProxy.mockResolvedValueOnce(okJson({ generations: [{ audio: btoa("x") }] }))
    const r = await generateHumeTTS("hi", { apiKey: "k" })
    expect(r.mimeType).toBe("audio/mpeg")
  })

  it("returns api-error when payload has no audio", async () => {
    mockProxy.mockResolvedValueOnce(okJson({ generations: [{}] }))
    const r = await generateHumeTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("returns api-error when result JSON parse fails", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => {
        throw new Error("bad json")
      },
    })
    const r = await generateHumeTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
  })

  it("returns api-error on non-2xx response", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 400,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => ({ message: "bad voice" }),
    })
    const r = await generateHumeTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("returns api-error when error JSON parse fails", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => {
        throw new Error("bad")
      },
    })
    const r = await generateHumeTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("wraps thrown error", async () => {
    mockProxy.mockRejectedValueOnce(new Error("eof"))
    const r = await generateHumeTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("handles non-Error throws", async () => {
    mockProxy.mockRejectedValueOnce(undefined)
    const r = await generateHumeTTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })
})
