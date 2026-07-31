import * as core from "@tauri-apps/api/core"
import { setTtsHost } from "../host"
import { generateEdgeTTS } from "./edge"

// Host-injected native-shell gate (ADR-0068 E3) — stands in for isTauri().
const mockIsTauri = jest.fn()
const mockInvoke = core.invoke as unknown as jest.Mock

beforeEach(() => {
  mockIsTauri.mockReset()
  mockInvoke.mockReset()
  setTtsHost({ isNativeShell: () => mockIsTauri() as boolean })
})

afterAll(() => {
  setTtsHost({})
})

describe("generateEdgeTTS", () => {
  it("rejects oversized text", async () => {
    mockIsTauri.mockReturnValue(true)
    const r = await generateEdgeTTS("x".repeat(10001))
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/maximum length/i)
  })

  it("returns desktop-only error in browser mode", async () => {
    mockIsTauri.mockReturnValue(false)
    const r = await generateEdgeTTS("hi")
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/desktop app/i)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("calls tts_edge_synthesize with the request and decodes base64", async () => {
    mockIsTauri.mockReturnValue(true)
    const payload = btoa("hello-bytes")
    mockInvoke.mockResolvedValueOnce({ body_b64: payload, mime: "audio/mpeg" })
    const r = await generateEdgeTTS("hi", {
      voice: "en-US-AriaNeural",
      rate: "+10%",
      pitch: "+1Hz",
      volume: "+5%",
    })
    expect(r.success).toBe(true)
    expect(r.mimeType).toBe("audio/mpeg")
    expect(r.audioData).toBeInstanceOf(ArrayBuffer)
    expect((r.audioData as ArrayBuffer).byteLength).toBe("hello-bytes".length)
    expect(mockInvoke).toHaveBeenCalledWith("tts_edge_synthesize", {
      request: {
        text: "hi",
        voice: "en-US-AriaNeural",
        rate: "+10%",
        pitch: "+1Hz",
        volume: "+5%",
      },
    })
  })

  it("uses default voice/rate/pitch/volume when omitted", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce({ body_b64: "", mime: "" })
    await generateEdgeTTS("hi")
    expect(mockInvoke).toHaveBeenCalledWith("tts_edge_synthesize", {
      request: {
        text: "hi",
        voice: "en-US-JennyNeural",
        rate: "+0%",
        pitch: "+0Hz",
        volume: "+0%",
      },
    })
  })

  it("falls back to audio/mpeg when the response mime is empty", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce({ body_b64: "", mime: "" })
    const r = await generateEdgeTTS("hi")
    expect(r.mimeType).toBe("audio/mpeg")
  })

  it("returns api-error when invoke throws an Error", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockRejectedValueOnce(new Error("WS closed"))
    const r = await generateEdgeTTS("hi")
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/TTS API returned an error/)
  })

  it("stringifies non-Error throws", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockRejectedValueOnce("boom")
    const r = await generateEdgeTTS("hi")
    expect(r.error).toMatch(/TTS API returned an error/)
  })
})
