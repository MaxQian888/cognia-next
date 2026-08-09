jest.mock("../proxy-fetch", () => ({ proxyFetch: jest.fn() }))

import { proxyFetch } from "../proxy-fetch"
import { generateOpenAITTS } from "./openai"

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

describe("generateOpenAITTS", () => {
  it("requires an API key", async () => {
    const r = await generateOpenAITTS("hi", { apiKey: "" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/API key is required/)
  })

  it("rejects oversized text", async () => {
    const r = await generateOpenAITTS("x".repeat(4097), { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/maximum length/i)
  })

  it("posts to /v1/audio/speech with Bearer auth and clamps speed", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    const r = await generateOpenAITTS("hi", { apiKey: "k", speed: 10 })
    expect(r.success).toBe(true)
    expect(r.mimeType).toBe("audio/mpeg")
    const [url, init] = mockProxy.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/audio/speech")
    expect(init.headers.Authorization).toBe("Bearer k")
    expect(init.json.speed).toBe(4.0)
    expect(init.json.model).toBe("gpt-4o-mini-tts")
  })

  it("clamps speed below the floor", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    await generateOpenAITTS("hi", { apiKey: "k", speed: 0.05 })
    expect(mockProxy.mock.calls[0][1].json.speed).toBe(0.25)
  })

  it("includes instructions only for gpt-4o-mini-tts model", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    await generateOpenAITTS("hi", {
      apiKey: "k",
      model: "gpt-4o-mini-tts",
      instructions: "Whisper softly",
    })
    expect(mockProxy.mock.calls[0][1].json.instructions).toBe("Whisper softly")
  })

  it("drops instructions on legacy models", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    await generateOpenAITTS("hi", {
      apiKey: "k",
      model: "tts-1",
      instructions: "ignored",
    })
    expect(mockProxy.mock.calls[0][1].json.instructions).toBeUndefined()
  })

  it.each([
    ["mp3", "audio/mpeg"],
    ["opus", "audio/opus"],
    ["aac", "audio/aac"],
    ["flac", "audio/flac"],
    ["wav", "audio/wav"],
  ] as const)("maps response_format %s to mime %s", async (fmt, mime) => {
    mockProxy.mockResolvedValueOnce({ ...ok(), mime: "application/octet-stream" })
    const r = await generateOpenAITTS("hi", { apiKey: "k", responseFormat: fmt })
    expect(r.mimeType).toBe(mime)
    expect(mockProxy.mock.calls[0][1].json.response_format).toBe(fmt)
  })

  it("normalizes the response Content-Type and rejects raw PCM", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    mockProxy.mockResolvedValueOnce({ ...ok(), mime: "audio/pcm; rate=24000" })
    await expect(generateOpenAITTS("hi", { apiKey: "k" })).resolves.toMatchObject({
      success: true,
      mimeType: "audio/mpeg",
    })
    await expect(generateOpenAITTS("hi", { apiKey: "k" })).resolves.toMatchObject({
      success: false,
      errorType: "not-supported",
    })
  })

  it("returns an api-error on a non-2xx response", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => ({ error: { message: "bad key" } }),
    })
    const r = await generateOpenAITTS("hi", { apiKey: "k" })
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
        throw new Error("bad")
      },
    })
    const r = await generateOpenAITTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("wraps thrown errors as network-error", async () => {
    mockProxy.mockRejectedValueOnce(new Error("offline"))
    const r = await generateOpenAITTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Network error/)
  })

  it("handles non-Error throws", async () => {
    mockProxy.mockRejectedValueOnce("nope")
    const r = await generateOpenAITTS("hi", { apiKey: "k" })
    expect(r.error).toMatch(/Network error/)
  })
})
