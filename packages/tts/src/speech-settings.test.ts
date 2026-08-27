import { getProviderRuntimeOptions, selectSpeechSettings, toTTSSettings } from "./speech-settings"
import { DEFAULT_SPEECH_SETTINGS } from "./types"

describe("selectSpeechSettings", () => {
  it("returns full defaults for null input", () => {
    expect(selectSpeechSettings(null)).toEqual(DEFAULT_SPEECH_SETTINGS)
  })

  it("layers AppSettings on top of defaults without losing untouched fields", () => {
    // A realistic AppSettings-shaped row: TTS fields flat among unrelated
    // app fields. Hoisted to a variable so structural typing (not the fresh-
    // literal excess-property check) applies — exactly how the app passes
    // its settings row into the structural SpeechSettingsSource parameter.
    const appSettingsRow = {
      id: "singleton",
      alwaysAllowTools: [] as string[],
      builtinTools: {
        fileExtras: true,
        git: true,
        process: false,
        environment: true,
        shellAdvanced: false,
      },
      ttsEnabled: true,
      ttsProvider: "openai",
      openaiVoice: "nova",
      sttLanguage: "zh-CN",
    }
    const out = selectSpeechSettings(appSettingsRow)
    expect(out.ttsEnabled).toBe(true)
    expect(out.ttsProvider).toBe("openai")
    expect(out.openaiVoice).toBe("nova")
    expect(out.sttLanguage).toBe("zh-CN")
    // Unchanged fields fall back to defaults.
    expect(out.openaiModel).toBe(DEFAULT_SPEECH_SETTINGS.openaiModel)
    expect(out.ttsRate).toBe(DEFAULT_SPEECH_SETTINGS.ttsRate)
  })

  it("normalizes legacy raw PCM settings to a playable buffered format", () => {
    const out = selectSpeechSettings({
      openaiResponseFormat: "pcm",
      localOpenaiResponseFormat: "pcm",
      mistralResponseFormat: "pcm",
    })
    expect(out.openaiResponseFormat).toBe("mp3")
    expect(out.localOpenaiResponseFormat).toBe("mp3")
    expect(out.mistralResponseFormat).toBe("mp3")
  })

  it.each(["unknown-provider", "edge", "openai-realtime"])(
    "normalizes unavailable persisted provider %s to system",
    (ttsProvider) => {
      expect(selectSpeechSettings({ ttsProvider }).ttsProvider).toBe("system")
    }
  )
})

describe("toTTSSettings", () => {
  it("strips sttLanguage and keeps the rest", () => {
    const tts = toTTSSettings({ ...DEFAULT_SPEECH_SETTINGS, sttLanguage: "ja-JP" })
    expect("sttLanguage" in tts).toBe(false)
    expect(tts.ttsProvider).toBe(DEFAULT_SPEECH_SETTINGS.ttsProvider)
  })
})

describe("getProviderRuntimeOptions", () => {
  it("emits provider-specific keys", () => {
    const s = { ...DEFAULT_SPEECH_SETTINGS }
    expect(getProviderRuntimeOptions(s, "openai")).toMatchObject({
      voice: s.openaiVoice,
      model: s.openaiModel,
    })
    expect(getProviderRuntimeOptions(s, "edge")).toMatchObject({
      voice: s.systemVoice,
      rate: s.ttsRate,
      pitch: s.ttsPitch,
    })
    expect(getProviderRuntimeOptions(s, "cartesia")).toMatchObject({
      voice: s.cartesiaVoice,
      model: s.cartesiaModel,
      language: s.cartesiaLanguage,
    })
  })

  it("system provider includes lang from sttLanguage", () => {
    const s = { ...DEFAULT_SPEECH_SETTINGS, sttLanguage: "fr-FR" }
    expect(getProviderRuntimeOptions(s, "system")).toMatchObject({ lang: "fr-FR" })
  })

  it("normalizes an unknown provider id to system controls", () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getProviderRuntimeOptions(DEFAULT_SPEECH_SETTINGS, "bogus" as any)
    ).toMatchObject({
      voice: DEFAULT_SPEECH_SETTINGS.systemVoice,
      lang: DEFAULT_SPEECH_SETTINGS.sttLanguage,
    })
  })
})
