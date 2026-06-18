/**
 * Registry parity guard. Locks the adapter outputs to the values the former
 * per-provider switches produced, so the refactor (and future provider
 * additions) can't silently drift voice/model/cache-key behavior.
 */

import { TTS_ADAPTERS, getAdapter } from "@/lib/tts/providers/registry"
import { DEFAULT_SPEECH_SETTINGS, TTS_PROVIDERS, type TTSProvider } from "@/types/media/tts"

const ALL_PROVIDERS = Object.keys(TTS_PROVIDERS) as TTSProvider[]

describe("TTS provider registry", () => {
  it("has an adapter for every TTSProvider", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(TTS_ADAPTERS[provider]).toBeDefined()
      expect(getAdapter(provider).info.id).toBe(provider)
    }
  })

  it("wires kind + generate consistently", () => {
    expect(getAdapter("system").kind).toBe("system")
    expect(getAdapter("system").generate).toBeUndefined()
    expect(getAdapter("openai-realtime").kind).toBe("streaming")
    expect(typeof getAdapter("openai-realtime").generateStream).toBe("function")
    for (const provider of ALL_PROVIDERS) {
      const adapter = getAdapter(provider)
      if (adapter.kind === "http") {
        expect(typeof adapter.generate).toBe("function")
      }
      if (adapter.kind === "streaming") {
        expect(typeof adapter.generateStream).toBe("function")
      }
    }
  })

  const runtimeExpectations: Record<TTSProvider, Record<string, unknown>> = {
    system: { voice: "", rate: 1.0, pitch: 1.0, volume: 1.0, lang: "en-US" },
    openai: {
      voice: "alloy",
      model: "gpt-4o-mini-tts",
      speed: 1.0,
      instructions: "",
      responseFormat: "mp3",
    },
    gemini: { voice: "Kore" },
    edge: {
      voice: "en-US-JennyNeural",
      rate: "+0%",
      pitch: "+0Hz",
      customSSMLEnabled: false,
      customSSML: "",
    },
    elevenlabs: {
      voice: "rachel",
      model: "eleven_multilingual_v2",
      stability: 0.5,
      similarityBoost: 0.75,
    },
    lmnt: { voice: "lily", speed: 1.0 },
    hume: { voice: "kora" },
    cartesia: {
      voice: "a0e99841-438c-4a64-b679-ae501e7d6091",
      model: "sonic-3",
      language: "en",
      speed: 0,
      emotion: "",
    },
    deepgram: { voice: "aura-2-asteria-en" },
    xiaomi: { voice: "mimo_default", model: "mimo-v2-tts", style: "", dialect: "" },
    "openai-realtime": { voice: "marin", model: "gpt-realtime", instructions: "" },
  }

  it.each(ALL_PROVIDERS)("runtimeOptions(%s) matches the legacy switch", (provider) => {
    expect(getAdapter(provider).runtimeOptions(DEFAULT_SPEECH_SETTINGS)).toEqual(
      runtimeExpectations[provider]
    )
  })

  it("folds the same cache-key fields the legacy spread produced", () => {
    expect(getAdapter("openai").cacheKeyFields(DEFAULT_SPEECH_SETTINGS)).toEqual({
      voice: "alloy",
      model: "gpt-4o-mini-tts",
      speed: 1.0,
      instructions: "",
      responseFormat: "mp3",
    })
    // Edge only includes customSSML when the toggle is on.
    expect(getAdapter("edge").cacheKeyFields(DEFAULT_SPEECH_SETTINGS)).toEqual({
      voice: "en-US-JennyNeural",
      rate: "+0%",
      pitch: "+0Hz",
      customSSML: undefined,
    })
    expect(
      getAdapter("edge").cacheKeyFields({
        ...DEFAULT_SPEECH_SETTINGS,
        ttsCustomSSMLEnabled: true,
        ttsCustomSSML: "<speak/>",
      })
    ).toEqual({
      voice: "en-US-JennyNeural",
      rate: "+0%",
      pitch: "+0Hz",
      customSSML: "<speak/>",
    })
    // System and streaming providers are never chunk-cached → no fields.
    expect(getAdapter("system").cacheKeyFields(DEFAULT_SPEECH_SETTINGS)).toEqual({})
    expect(getAdapter("openai-realtime").cacheKeyFields(DEFAULT_SPEECH_SETTINGS)).toEqual({})
  })
})
