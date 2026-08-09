import { mimeForBufferedFormat, normalizeAudioMime } from "./audio-response"

describe("audio response MIME normalization", () => {
  it.each([
    ["mp3", "audio/mpeg"],
    ["opus", "audio/opus"],
    ["aac", "audio/aac"],
    ["flac", "audio/flac"],
    ["wav", "audio/wav"],
  ] as const)("maps %s to %s", (format, mime) => {
    expect(mimeForBufferedFormat(format)).toBe(mime)
  })

  it("strips Content-Type parameters from audio responses", () => {
    expect(normalizeAudioMime("audio/mpeg; charset=binary", "wav")).toEqual({
      success: true,
      mimeType: "audio/mpeg",
    })
  })

  it.each([undefined, null, "application/octet-stream", "binary/octet-stream"])(
    "uses the selected format only for generic binary content type %s",
    (contentType) => {
      expect(normalizeAudioMime(contentType, "wav")).toEqual({
        success: true,
        mimeType: "audio/wav",
      })
    }
  )

  it.each(["audio/pcm", "audio/l16; rate=24000", "audio/raw"])(
    "rejects raw PCM content type %s",
    (contentType) => {
      expect(normalizeAudioMime(contentType, "mp3")).toMatchObject({
        success: false,
        errorType: "not-supported",
      })
    }
  )

  it("rejects non-audio structured responses instead of guessing", () => {
    expect(normalizeAudioMime("application/json; charset=utf-8", "mp3")).toMatchObject({
      success: false,
      errorType: "not-supported",
      providerMessage: "Unexpected TTS response content type: application/json",
    })
  })
})
