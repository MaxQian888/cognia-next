jest.mock("../proxy-fetch", () => ({ proxyFetch: jest.fn() }))

import { proxyFetch } from "../proxy-fetch"
import { generateXiaomiTTS } from "./xiaomi"

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

function errorJson(status: number, message: string) {
  return {
    ok: false,
    status,
    mime: "application/json",
    bytes: new ArrayBuffer(0),
    text: async () => JSON.stringify({ error: { message } }),
    json: async () => ({ error: { message } }),
  }
}

beforeEach(() => mockProxy.mockReset())

describe("generateXiaomiTTS", () => {
  it("requires an API key", async () => {
    const r = await generateXiaomiTTS("hi", { apiKey: "" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/API key is required/)
  })

  it("rejects oversized text", async () => {
    const r = await generateXiaomiTTS("x".repeat(8001), { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/maximum length/i)
  })

  it("posts to /v1/chat/completions and decodes base64 wav", async () => {
    const audioB64 = btoa("abcd")
    mockProxy.mockResolvedValueOnce(
      okJson({ choices: [{ message: { audio: { data: audioB64 } } }] })
    )
    const r = await generateXiaomiTTS("hello", { apiKey: "k" })
    expect(r.success).toBe(true)
    expect(r.mimeType).toBe("audio/wav")
    const [url, init] = mockProxy.mock.calls[0]
    expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions")
    expect(init.headers.Authorization).toBe("Bearer k")
    expect(init.json.model).toBe("mimo-v2-tts")
    expect(init.json.audio.format).toBe("wav")
    expect(init.json.audio.voice).toBe("mimo_default")
    expect((r.audioData as ArrayBuffer).byteLength).toBe(4)
  })

  it("sends only assistant message when no style/dialect", async () => {
    mockProxy.mockResolvedValueOnce(
      okJson({ choices: [{ message: { audio: { data: btoa("a") } } }] })
    )
    await generateXiaomiTTS("test", { apiKey: "k" })
    const messages = mockProxy.mock.calls[0][1].json.messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({ role: "assistant", content: "test" })
  })

  it("prepends user style message when style is set", async () => {
    mockProxy.mockResolvedValueOnce(
      okJson({ choices: [{ message: { audio: { data: btoa("a") } } }] })
    )
    await generateXiaomiTTS("test", { apiKey: "k", style: "开心" })
    const messages = mockProxy.mock.calls[0][1].json.messages
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("user")
    expect(messages[0].content).toContain("[开心]")
    expect(messages[1]).toEqual({ role: "assistant", content: "test" })
  })

  it("includes dialect in style hint", async () => {
    mockProxy.mockResolvedValueOnce(
      okJson({ choices: [{ message: { audio: { data: btoa("a") } } }] })
    )
    await generateXiaomiTTS("test", { apiKey: "k", dialect: "东北话" })
    const messages = mockProxy.mock.calls[0][1].json.messages
    expect(messages[0].content).toContain("[东北话]")
  })

  it("combines style and dialect in style hint", async () => {
    mockProxy.mockResolvedValueOnce(
      okJson({ choices: [{ message: { audio: { data: btoa("a") } } }] })
    )
    await generateXiaomiTTS("test", { apiKey: "k", style: "开心", dialect: "四川话" })
    const messages = mockProxy.mock.calls[0][1].json.messages
    expect(messages[0].content).toContain("[开心]")
    expect(messages[0].content).toContain("[四川话]")
  })

  it("uses custom voice and model", async () => {
    mockProxy.mockResolvedValueOnce(
      okJson({ choices: [{ message: { audio: { data: btoa("a") } } }] })
    )
    await generateXiaomiTTS("test", { apiKey: "k", voice: "default_zh", model: "mimo-v2-tts" })
    const json = mockProxy.mock.calls[0][1].json
    expect(json.audio.voice).toBe("default_zh")
    expect(json.model).toBe("mimo-v2-tts")
  })

  it("returns api-error when response has no audio", async () => {
    mockProxy.mockResolvedValueOnce(okJson({ choices: [{ message: {} }] }))
    const r = await generateXiaomiTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toBeDefined()
  })

  it("returns api-error when choices is empty", async () => {
    mockProxy.mockResolvedValueOnce(okJson({ choices: [] }))
    const r = await generateXiaomiTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toBeDefined()
  })

  it("returns api-error on HTTP error", async () => {
    mockProxy.mockResolvedValueOnce(errorJson(401, "Unauthorized"))
    const r = await generateXiaomiTTS("hi", { apiKey: "bad" })
    expect(r.success).toBe(false)
    expect(r.error).toBeDefined()
  })

  it("returns network-error on fetch failure", async () => {
    mockProxy.mockRejectedValueOnce(new Error("Network fail"))
    const r = await generateXiaomiTTS("hi", { apiKey: "k" })
    expect(r.success).toBe(false)
    expect(r.error).toBeDefined()
  })
})
