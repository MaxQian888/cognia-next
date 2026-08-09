import {
  DEEPGRAM_TTS_VOICES,
  DEFAULT_SPEECH_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  ORDERED_TTS_PROVIDERS,
  REALTIME_TTS_MODELS,
  RETIRED_TTS_PROVIDERS,
  TTS_PROVIDERS,
  getApiKeyProvider,
  getEdgeVoicesByLanguage,
  getTTSError,
  providerRequiresApiKey,
  ttsFailure,
} from "./types"

describe("TTS types & helpers", () => {
  it("ships exactly the documented providers in TTS_PROVIDERS", () => {
    const ids = Object.keys(TTS_PROVIDERS).sort()
    expect(ids).toEqual(
      [
        "system",
        "openai",
        "local-openai-compatible",
        "openai-realtime",
        "gemini",
        "edge",
        "elevenlabs",
        "lmnt",
        "hume",
        "cartesia",
        "deepgram",
        "xiaomi",
        "mistral",
      ].sort()
    )
  })

  it("ORDERED_TTS_PROVIDERS lists every selectable provider once with system first", () => {
    // Edge and OpenAI realtime remain retired; the generic local endpoint is selectable.
    expect(ORDERED_TTS_PROVIDERS).toHaveLength(11)
    expect(ORDERED_TTS_PROVIDERS[0]).toBe("system")
    expect(new Set(ORDERED_TTS_PROVIDERS).size).toBe(11)
  })

  it("does not advertise buffered HTTP providers as transport streaming", () => {
    for (const [id, info] of Object.entries(TTS_PROVIDERS)) {
      if (id !== "system" && id !== "openai-realtime") {
        expect(info.supportsStreaming).toBe(false)
      }
    }
  })

  it("retires edge and openai-realtime on all three axes", () => {
    // Intentional dormancy per Rule 7: documented (RETIRED list), inert in the
    // picker (absent from ORDERED), but still resolvable providers so persisted
    // selections and the synthesis code keep working.
    for (const p of ["edge", "openai-realtime"] as const) {
      expect(RETIRED_TTS_PROVIDERS).toContain(p)
      expect(ORDERED_TTS_PROVIDERS).not.toContain(p)
      expect(TTS_PROVIDERS[p]).toBeDefined()
    }
  })

  it("DEFAULT_TTS_SETTINGS picks sensible defaults", () => {
    expect(DEFAULT_TTS_SETTINGS.ttsProvider).toBe("system")
    expect(DEFAULT_TTS_SETTINGS.ttsEnabled).toBe(false)
    expect(DEFAULT_TTS_SETTINGS.ttsRate).toBe(1)
    expect(DEFAULT_TTS_SETTINGS.openaiVoice).toBe("alloy")
    expect(DEFAULT_TTS_SETTINGS.elevenlabsVoice).toBe("rachel")
    expect(DEFAULT_TTS_SETTINGS.geminiModel).toBe("gemini-3.1-flash-tts-preview")
    expect(DEFAULT_TTS_SETTINGS.mistralModel).toBe("voxtral-mini-tts-2603")
  })

  it("DEFAULT_SPEECH_SETTINGS adds sttLanguage on top of TTS defaults", () => {
    expect(DEFAULT_SPEECH_SETTINGS.sttLanguage).toBe("en-US")
    expect(DEFAULT_SPEECH_SETTINGS.ttsProvider).toBe(DEFAULT_TTS_SETTINGS.ttsProvider)
  })

  it("offers current multilingual Deepgram voices and Realtime models", () => {
    expect(DEEPGRAM_TTS_VOICES.map((voice) => voice.id)).toEqual(
      expect.arrayContaining([
        "aura-2-thalia-en",
        "aura-2-celeste-es",
        "aura-2-rhea-nl",
        "aura-2-fujin-ja",
      ])
    )
    expect(REALTIME_TTS_MODELS.map((model) => model.id)).toEqual(
      expect.arrayContaining(["gpt-realtime-2.1", "gpt-realtime-2.1-mini"])
    )
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

  it("ttsFailure carries structured error detail (type, status, providerMessage)", () => {
    const r = ttsFailure("api-error", { status: 401, providerMessage: "Invalid API key" })
    expect(r.success).toBe(false)
    expect(r.errorType).toBe("api-error")
    expect(r.status).toBe(401)
    expect(r.providerMessage).toBe("Invalid API key")
    // The canonical message is still there for display.
    expect(r.error).toContain("TTS API returned an error")
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
