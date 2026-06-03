import {
  DEFAULT_SPEECH_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  ORDERED_TTS_PROVIDERS,
  TTS_PROVIDERS,
  getApiKeyProvider,
  getEdgeVoicesByLanguage,
  getTTSError,
  providerRequiresApiKey,
} from "./tts"

describe("TTS types & helpers", () => {
  it("ships exactly the 10 documented providers in TTS_PROVIDERS", () => {
    const ids = Object.keys(TTS_PROVIDERS).sort()
    expect(ids).toEqual(
      [
        "system",
        "openai",
        "gemini",
        "edge",
        "elevenlabs",
        "lmnt",
        "hume",
        "cartesia",
        "deepgram",
        "xiaomi",
      ].sort()
    )
  })

  it("ORDERED_TTS_PROVIDERS lists every provider once with system first", () => {
    expect(ORDERED_TTS_PROVIDERS).toHaveLength(10)
    expect(ORDERED_TTS_PROVIDERS[0]).toBe("system")
    expect(new Set(ORDERED_TTS_PROVIDERS).size).toBe(10)
  })

  it("DEFAULT_TTS_SETTINGS picks sensible defaults", () => {
    expect(DEFAULT_TTS_SETTINGS.ttsProvider).toBe("system")
    expect(DEFAULT_TTS_SETTINGS.ttsEnabled).toBe(false)
    expect(DEFAULT_TTS_SETTINGS.ttsRate).toBe(1)
    expect(DEFAULT_TTS_SETTINGS.openaiVoice).toBe("alloy")
    expect(DEFAULT_TTS_SETTINGS.elevenlabsVoice).toBe("rachel")
  })

  it("DEFAULT_SPEECH_SETTINGS adds sttLanguage on top of TTS defaults", () => {
    expect(DEFAULT_SPEECH_SETTINGS.sttLanguage).toBe("en-US")
    expect(DEFAULT_SPEECH_SETTINGS.ttsProvider).toBe(DEFAULT_TTS_SETTINGS.ttsProvider)
  })

  it("providerRequiresApiKey distinguishes free vs paid providers", () => {
    expect(providerRequiresApiKey("system")).toBe(false)
    expect(providerRequiresApiKey("edge")).toBe(false)
    expect(providerRequiresApiKey("openai")).toBe(true)
    expect(providerRequiresApiKey("elevenlabs")).toBe(true)
    expect(providerRequiresApiKey("gemini")).toBe(true)
  })

  it("getApiKeyProvider remaps gemini onto google", () => {
    expect(getApiKeyProvider("gemini")).toBe("google")
    expect(getApiKeyProvider("openai")).toBe("openai")
    expect(getApiKeyProvider("system")).toBeUndefined()
  })

  it("getTTSError fills in canned messages and preserves details", () => {
    const e = getTTSError("api-key-missing", "extra")
    expect(e.type).toBe("api-key-missing")
    expect(e.message).toContain("API key is required")
    expect(e.details).toBe("extra")
  })

  it("getEdgeVoicesByLanguage filters by language prefix", () => {
    const en = getEdgeVoicesByLanguage("en-GB")
    const zh = getEdgeVoicesByLanguage("zh-CN")
    expect(en.every((v) => v.language.startsWith("en"))).toBe(true)
    expect(zh.every((v) => v.language.startsWith("zh"))).toBe(true)
    expect(en.length).toBeGreaterThan(0)
    expect(zh.length).toBeGreaterThan(0)
  })
})
