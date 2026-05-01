import { getProviderRuntimeOptions, selectSpeechSettings, toTTSSettings } from "./speech-settings"
import { DEFAULT_SPEECH_SETTINGS } from "./types"

describe("selectSpeechSettings", () => {
  it("returns full defaults for null input", () => {
    expect(selectSpeechSettings(null)).toEqual(DEFAULT_SPEECH_SETTINGS)
  })

  it("layers AppSettings on top of defaults without losing untouched fields", () => {
    const out = selectSpeechSettings({
      id: "singleton",
      alwaysAllowTools: [],
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
    })
    expect(out.ttsEnabled).toBe(true)
    expect(out.ttsProvider).toBe("openai")
    expect(out.openaiVoice).toBe("nova")
    expect(out.sttLanguage).toBe("zh-CN")
    // Unchanged fields fall back to defaults.
    expect(out.openaiModel).toBe(DEFAULT_SPEECH_SETTINGS.openaiModel)
    expect(out.ttsRate).toBe(DEFAULT_SPEECH_SETTINGS.ttsRate)
  })
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
      voice: s.edgeVoice,
      rate: s.edgeRate,
      pitch: s.edgePitch,
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

  it("returns an empty object for an unknown provider id", () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getProviderRuntimeOptions(DEFAULT_SPEECH_SETTINGS, "bogus" as any)
    ).toEqual({})
  })
})
