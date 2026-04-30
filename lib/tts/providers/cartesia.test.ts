jest.mock("@/lib/tts/proxy-fetch", () => ({
  proxyFetch: jest.fn(),
}))

import { proxyFetch } from "@/lib/tts/proxy-fetch"
import { generateCartesiaTTS } from "./cartesia"

const mockProxy = proxyFetch as jest.Mock

function ok(bytes = new ArrayBuffer(4)) {
  return {
    ok: true,
    status: 200,
    mime: "audio/mpeg",
    bytes,
    text: async () => "",
    json: async () => ({}),
  }
}

beforeEach(() => mockProxy.mockReset())

describe("generateCartesiaTTS", () => {
  it("returns a missing-key error when apiKey is empty", async () => {
    const r = await generateCartesiaTTS("hi", { apiKey: "" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/API key is required/)
    expect(mockProxy).not.toHaveBeenCalled()
  })

  it("rejects oversized text", async () => {
    const huge = "x".repeat(10001)
    const r = await generateCartesiaTTS(huge, { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/maximum length/i)
  })

  it("posts JSON with required Cartesia headers and returns audio/mpeg", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    const r = await generateCartesiaTTS("hello", { apiKey: "kkk" })
    expect(r.success).toBe(true)
    expect(r.mimeType).toBe("audio/mpeg")
    const [url, init] = mockProxy.mock.calls[0]
    expect(url).toBe("https://api.cartesia.ai/tts/bytes")
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Bearer kkk")
    expect(init.headers["X-API-Key"]).toBe("kkk")
    expect(init.headers["Cartesia-Version"]).toBe("2025-04-16")
    expect(init.json.transcript).toBe("hello")
    expect(init.json.voice).toEqual({ mode: "id", id: "a0e99841-438c-4a64-b679-ae501e7d6091" })
    expect(init.json.output_format.container).toBe("mp3")
  })

  it("emits wav output format on demand", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    const r = await generateCartesiaTTS("hi", { apiKey: "k", outputFormat: "wav" })
    expect(r.mimeType).toBe("audio/wav")
    expect(mockProxy.mock.calls[0][1].json.output_format.container).toBe("wav")
  })

  it("emits raw pcm output format on demand", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    const r = await generateCartesiaTTS("hi", { apiKey: "k", outputFormat: "raw" })
    expect(r.mimeType).toBe("audio/pcm")
    expect(mockProxy.mock.calls[0][1].json.output_format.container).toBe("raw")
  })

  it("includes generation_config when speed/emotion is provided", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    await generateCartesiaTTS("hi", {
      apiKey: "k",
      speed: 1.2,
      emotion: " happy ",
    })
    const body = mockProxy.mock.calls[0][1].json
    expect(body.generation_config).toEqual({ speed: 1.2, emotion: "happy" })
  })

  it("omits generation_config when none of speed/emotion are set", async () => {
    mockProxy.mockResolvedValueOnce(ok())
    await generateCartesiaTTS("hi", { apiKey: "k" })
    const body = mockProxy.mock.calls[0][1].json
    expect(body.generation_config).toBeUndefined()
  })

  it("returns an api-error message on a non-2xx response", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => ({ message: "bad token" }),
    })
    const r = await generateCartesiaTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("returns an api-error when the error JSON cannot be parsed", async () => {
    mockProxy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      mime: "application/json",
      bytes: new ArrayBuffer(0),
      text: async () => "",
      json: async () => {
        throw new Error("not json")
      },
    })
    const r = await generateCartesiaTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("returns an api-error when proxyFetch throws", async () => {
    mockProxy.mockRejectedValueOnce(new Error("network down"))
    const r = await generateCartesiaTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("handles non-Error throws", async () => {
    mockProxy.mockRejectedValueOnce("nope")
    const r = await generateCartesiaTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })
})
