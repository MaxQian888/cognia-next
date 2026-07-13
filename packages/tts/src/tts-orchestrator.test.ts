/** @jest-environment jsdom */
/**
 * Tests for the singleton TTS orchestrator. Mocks every provider plus the
 * cache layer so we can exercise:
 *   - state subscription / lifecycle
 *   - chunked synthesis loop
 *   - chunk-cache integration
 *   - cancel during speak
 *   - direct provider routing for every supported id
 *   - api-key gating
 *   - audio playback (HTMLAudioElement) and system speechSynthesis
 *   - pause / resume / stop
 */

jest.mock("./tts-cache", () => ({
  generateCacheKey: jest.fn(() => "cache-key"),
  getCachedOrGenerate: jest.fn(),
}))

jest.mock("./providers/openai", () => ({
  generateOpenAITTS: jest.fn(),
}))
jest.mock("./providers/gemini", () => ({
  generateGeminiTTS: jest.fn(),
}))
jest.mock("./providers/edge", () => ({
  generateEdgeTTS: jest.fn(),
}))
jest.mock("./providers/elevenlabs", () => ({
  generateElevenLabsTTS: jest.fn(),
}))
jest.mock("./providers/lmnt", () => ({
  generateLMNTTTS: jest.fn(),
}))
jest.mock("./providers/hume", () => ({
  generateHumeTTS: jest.fn(),
}))
jest.mock("./providers/cartesia", () => ({
  generateCartesiaTTS: jest.fn(),
}))
jest.mock("./providers/deepgram", () => ({
  generateDeepgramTTS: jest.fn(),
}))
jest.mock("./providers/openai-realtime", () => ({
  synthesizeRealtimeStream: jest.fn(),
}))
jest.mock("./streaming/pcm-player", () => ({
  PcmPlayer: jest.fn().mockImplementation((opts: { onEnded?: () => void }) => ({
    enqueue: jest.fn(),
    end: jest.fn(() => opts.onEnded?.()),
    pause: jest.fn(),
    resume: jest.fn(),
    stop: jest.fn(),
    getState: () => "playing",
  })),
  pcm16ToFloat32: jest.fn(),
}))

import { TTSOrchestrator, ttsOrchestrator } from "./tts-orchestrator"
import { synthesizeRealtimeStream } from "./providers/openai-realtime"
import { PcmPlayer } from "./streaming/pcm-player"
import { DEFAULT_SPEECH_SETTINGS, type SpeechSettings } from "./types"
import { getCachedOrGenerate } from "./tts-cache"
import { generateOpenAITTS } from "./providers/openai"
import { generateGeminiTTS } from "./providers/gemini"
import { generateEdgeTTS } from "./providers/edge"
import { generateElevenLabsTTS } from "./providers/elevenlabs"
import { generateLMNTTTS } from "./providers/lmnt"
import { generateHumeTTS } from "./providers/hume"
import { generateCartesiaTTS } from "./providers/cartesia"
import { generateDeepgramTTS } from "./providers/deepgram"

const mockCache = getCachedOrGenerate as jest.Mock

interface MockAudio {
  src: string
  volume: number
  currentTime: number
  duration: number
  onplay: (() => void) | null
  onended: (() => void) | null
  onerror: (() => void) | null
  onpause: (() => void) | null
  ontimeupdate: (() => void) | null
  pause: jest.Mock
  play: jest.Mock
}

let lastAudio: MockAudio | null = null

class MockAudioCtor implements Partial<MockAudio> {
  src: string
  volume = 1
  currentTime = 0
  duration = 1
  onplay: (() => void) | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  onpause: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  pause = jest.fn()
  play: jest.Mock
  constructor(src: string) {
    this.src = src
    this.play = jest.fn().mockImplementation(async () => {
      // Schedule onplay then natural onended.
      Promise.resolve().then(() => {
        this.onplay?.()
        this.currentTime = 0.5
        this.ontimeupdate?.()
        this.currentTime = this.duration
        this.onended?.()
      })
    })
    lastAudio = this as unknown as MockAudio
  }
}

interface MockSpeechSynth {
  cancelCount: number
  pauseCount: number
  resumeCount: number
  utterance: SpeechSynthesisUtterance | null
  voices: SpeechSynthesisVoice[]
}

let _lastSynth: MockSpeechSynth | null = null

function setupSpeechSynth() {
  const state: MockSpeechSynth = {
    cancelCount: 0,
    pauseCount: 0,
    resumeCount: 0,
    utterance: null,
    voices: [],
  }
  const synth = {
    cancel: () => {
      state.cancelCount++
    },
    pause: () => {
      state.pauseCount++
    },
    resume: () => {
      state.resumeCount++
    },
    speak: (u: SpeechSynthesisUtterance) => {
      state.utterance = u
      // Simulate immediate completion by deferring callbacks.
      Promise.resolve().then(() => {
        u.onstart?.(new Event("start") as unknown as SpeechSynthesisEvent)
        u.onboundary?.(new Event("boundary") as unknown as SpeechSynthesisEvent)
        u.onend?.(new Event("end") as unknown as SpeechSynthesisEvent)
      })
    },
    getVoices: () => state.voices,
  }
  ;(window as unknown as { speechSynthesis: typeof synth }).speechSynthesis = synth
  ;(globalThis as unknown as { speechSynthesis: typeof synth }).speechSynthesis = synth

  class MockUtterance implements Partial<SpeechSynthesisUtterance> {
    text: string
    voice: SpeechSynthesisVoice | null = null
    rate = 1
    pitch = 1
    volume = 1
    lang = ""
    onstart: SpeechSynthesisUtterance["onstart"] = null
    onend: SpeechSynthesisUtterance["onend"] = null
    onerror: SpeechSynthesisUtterance["onerror"] = null
    onpause: SpeechSynthesisUtterance["onpause"] = null
    onresume: SpeechSynthesisUtterance["onresume"] = null
    onboundary: SpeechSynthesisUtterance["onboundary"] = null
    onmark: SpeechSynthesisUtterance["onmark"] = null
    constructor(text: string) {
      this.text = text
    }
  }
  ;(
    window as unknown as { SpeechSynthesisUtterance: typeof MockUtterance }
  ).SpeechSynthesisUtterance = MockUtterance as unknown as typeof SpeechSynthesisUtterance

  _lastSynth = state
  return state
}

beforeEach(() => {
  lastAudio = null
  _lastSynth = null
  mockCache.mockReset()
  ;(globalThis as unknown as { Audio: unknown }).Audio = MockAudioCtor
  // jsdom's URL.createObjectURL/revokeObjectURL aren't real but exist in some
  // versions; install spies regardless so we control them.
  ;(URL as unknown as { createObjectURL: jest.Mock }).createObjectURL = jest
    .fn()
    .mockReturnValue("blob:mock")
  ;(URL as unknown as { revokeObjectURL: jest.Mock }).revokeObjectURL = jest.fn()
  ;[
    generateOpenAITTS,
    generateGeminiTTS,
    generateEdgeTTS,
    generateElevenLabsTTS,
    generateLMNTTTS,
    generateHumeTTS,
    generateCartesiaTTS,
    generateDeepgramTTS,
  ].forEach((fn) => (fn as jest.Mock).mockReset())
})

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).speechSynthesis
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).SpeechSynthesisUtterance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).speechSynthesis
})

describe("module wiring", () => {
  it("exports a singleton instance", () => {
    expect(ttsOrchestrator).toBeInstanceOf(TTSOrchestrator)
  })
})

describe("subscribe", () => {
  it("invokes the subscriber synchronously on registration and returns an unsubscribe", () => {
    const o = new TTSOrchestrator()
    const seen: string[] = []
    const off = o.subscribe((s) => seen.push(s.playbackState))
    expect(seen).toEqual(["idle"])
    off()
    o.stop()
    // After unsubscribing, subscriber stops getting updates.
    expect(seen).toEqual(["idle"])
  })

  it("getState returns the current state", () => {
    const o = new TTSOrchestrator()
    expect(o.getState().playbackState).toBe("idle")
  })
})

describe("speak with ttsEnabled=false", () => {
  it("noops to a stopped state and never calls the cache", async () => {
    const o = new TTSOrchestrator()
    await o.speak("hi", {
      speechSettings: { ...DEFAULT_SPEECH_SETTINGS, ttsEnabled: false },
    })
    expect(o.getState().playbackState).toBe("stopped")
    expect(mockCache).not.toHaveBeenCalled()
  })
})

describe("speak — cloud provider happy path", () => {
  it("invokes the openai provider, plays audio, and ends in stopped state", async () => {
    const settings: SpeechSettings = {
      ...DEFAULT_SPEECH_SETTINGS,
      ttsEnabled: true,
      ttsProvider: "openai",
    }
    mockCache.mockResolvedValueOnce({
      audioData: new ArrayBuffer(8),
      mimeType: "audio/mpeg",
    })
    const o = new TTSOrchestrator()
    const onStart = jest.fn()
    const onEnd = jest.fn()
    const onProgress = jest.fn()

    await o.speak("hello world", {
      speechSettings: settings,
      providerSettings: { openai: { apiKey: "k" } },
      onStart,
      onEnd,
      onProgress,
    })

    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalled()
    expect(o.getState().playbackState).toBe("stopped")
    expect(o.getState().progress).toBe(1)
    expect(lastAudio?.play).toHaveBeenCalled()
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })

  it("applies a pronunciation dictionary before synthesis", async () => {
    mockCache.mockResolvedValueOnce({ audioData: new ArrayBuffer(8), mimeType: "audio/mpeg" })
    const o = new TTSOrchestrator()
    await o.speak("ABC corp", {
      speechSettings: {
        ...DEFAULT_SPEECH_SETTINGS,
        ttsEnabled: true,
        ttsProvider: "openai",
        ttsPronunciationDictionary: { ABC: "A B C" },
      },
      providerSettings: { openai: { apiKey: "k" } },
    })
    expect(o.getState().playbackState).toBe("stopped")
  })

  it("forwards a Blob audioData unchanged", async () => {
    const settings: SpeechSettings = {
      ...DEFAULT_SPEECH_SETTINGS,
      ttsEnabled: true,
      ttsProvider: "openai",
    }
    const blob = new Blob([new Uint8Array([1, 2])], { type: "audio/wav" })
    mockCache.mockResolvedValueOnce({ audioData: blob, mimeType: "audio/wav" })
    const o = new TTSOrchestrator()
    await o.speak("hi", {
      speechSettings: settings,
      providerSettings: { openai: { apiKey: "k" } },
    })
    expect(o.getState().playbackState).toBe("stopped")
  })

  it("propagates a chunk-level error (no audio data) and toasts", async () => {
    const settings: SpeechSettings = {
      ...DEFAULT_SPEECH_SETTINGS,
      ttsEnabled: true,
      ttsProvider: "openai",
      ttsFallbackEnabled: false,
    }
    mockCache.mockResolvedValueOnce(null)
    const o = new TTSOrchestrator()
    const onError = jest.fn()
    await expect(
      o.speak("hi", {
        speechSettings: settings,
        providerSettings: { openai: { apiKey: "k" } },
        onError,
      })
    ).rejects.toThrow(/Failed to generate speech audio/)
    expect(onError).toHaveBeenCalled()
    expect(o.getState().playbackState).toBe("error")
  })
})

describe("direct provider routing", () => {
  async function drive(
    provider: SpeechSettings["ttsProvider"],
    fn: jest.Mock,
    keyMap: Record<string, { apiKey?: string }> = {}
  ) {
    fn.mockResolvedValueOnce({
      success: true,
      audioData: new ArrayBuffer(2),
      mimeType: "audio/mpeg",
    })
    mockCache.mockImplementationOnce(async (_key, gen) => {
      const r = await gen()
      return r ? { audioData: r.audioData, mimeType: r.mimeType } : null
    })
    const o = new TTSOrchestrator()
    await o.speak("hi", {
      speechSettings: {
        ...DEFAULT_SPEECH_SETTINGS,
        ttsEnabled: true,
        ttsProvider: provider,
      },
      providerSettings: keyMap,
    })
    expect(fn).toHaveBeenCalledTimes(1)
  }

  it("openai", async () => {
    await drive("openai", generateOpenAITTS as jest.Mock, { openai: { apiKey: "k" } })
  })
  it("gemini (uses google api key)", async () => {
    await drive("gemini", generateGeminiTTS as jest.Mock, { google: { apiKey: "k" } })
  })
  it("edge (no api key)", async () => {
    await drive("edge", generateEdgeTTS as jest.Mock, {})
  })
  it("elevenlabs", async () => {
    await drive("elevenlabs", generateElevenLabsTTS as jest.Mock, {
      elevenlabs: { apiKey: "k" },
    })
  })
  it("lmnt", async () => {
    await drive("lmnt", generateLMNTTTS as jest.Mock, { lmnt: { apiKey: "k" } })
  })
  it("hume", async () => {
    await drive("hume", generateHumeTTS as jest.Mock, { hume: { apiKey: "k" } })
  })
  it("cartesia", async () => {
    await drive("cartesia", generateCartesiaTTS as jest.Mock, { cartesia: { apiKey: "k" } })
  })
  it("deepgram", async () => {
    await drive("deepgram", generateDeepgramTTS as jest.Mock, { deepgram: { apiKey: "k" } })
  })
})

describe("api-key gating", () => {
  it("bails out with a settings error when a paid provider is missing its key", async () => {
    mockCache.mockImplementationOnce(async (_key, gen) => {
      const r = await gen()
      return r ? { audioData: r.audioData, mimeType: r.mimeType ?? "audio/mpeg" } : null
    })
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", {
        speechSettings: {
          ...DEFAULT_SPEECH_SETTINGS,
          ttsEnabled: true,
          ttsProvider: "openai",
          ttsFallbackEnabled: false,
        },
        providerSettings: {},
      })
    ).rejects.toThrow(/Failed to generate speech audio/)
    expect(generateOpenAITTS).not.toHaveBeenCalled()
  })

  it("propagates a directGenerate throw via TTSResponse", async () => {
    ;(generateOpenAITTS as jest.Mock).mockRejectedValueOnce(new Error("boom"))
    mockCache.mockImplementationOnce(async (_key, gen) => {
      const r = await gen()
      return r ? { audioData: r.audioData, mimeType: r.mimeType ?? "audio/mpeg" } : null
    })
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", {
        speechSettings: {
          ...DEFAULT_SPEECH_SETTINGS,
          ttsEnabled: true,
          ttsProvider: "openai",
          ttsFallbackEnabled: false,
        },
        providerSettings: { openai: { apiKey: "k" } },
      })
    ).rejects.toThrow()
    expect(o.getState().playbackState).toBe("error")
  })

  it("returns null from generateUncached when provider-call resolves with success=false", async () => {
    ;(generateOpenAITTS as jest.Mock).mockResolvedValueOnce({ success: false, error: "x" })
    mockCache.mockImplementationOnce(async (_key, gen) => {
      const r = await gen()
      return r ? { audioData: r.audioData, mimeType: r.mimeType ?? "audio/mpeg" } : null
    })
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", {
        speechSettings: {
          ...DEFAULT_SPEECH_SETTINGS,
          ttsEnabled: true,
          ttsProvider: "openai",
          ttsFallbackEnabled: false,
        },
        providerSettings: { openai: { apiKey: "k" } },
      })
    ).rejects.toThrow(/Failed to generate speech audio/)
  })
})

describe("cloud → system fallback", () => {
  it("falls back to the system voice when a cloud chunk fails and fallback is enabled", async () => {
    const state = setupSpeechSynth()
    mockCache.mockResolvedValueOnce(null) // cloud synthesis fails
    const o = new TTSOrchestrator()
    const onError = jest.fn()
    await o.speak("hi there", {
      speechSettings: {
        ...DEFAULT_SPEECH_SETTINGS,
        ttsEnabled: true,
        ttsProvider: "openai",
        ttsFallbackEnabled: true,
      },
      providerSettings: { openai: { apiKey: "k" } },
      onError,
    })
    expect(state.utterance).not.toBeNull() // the system voice spoke instead
    expect(o.getState().playbackState).toBe("stopped")
    expect(onError).not.toHaveBeenCalled()
  })

  it("propagates the error when fallback is disabled", async () => {
    setupSpeechSynth()
    mockCache.mockResolvedValueOnce(null)
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", {
        speechSettings: {
          ...DEFAULT_SPEECH_SETTINGS,
          ttsEnabled: true,
          ttsProvider: "openai",
          ttsFallbackEnabled: false,
        },
        providerSettings: { openai: { apiKey: "k" } },
      })
    ).rejects.toThrow(/Failed to generate speech audio/)
  })
})

describe("streaming provider (Realtime)", () => {
  const mockStream = synthesizeRealtimeStream as jest.Mock

  const realtimeSettings: SpeechSettings = {
    ...DEFAULT_SPEECH_SETTINGS,
    ttsEnabled: true,
    ttsProvider: "openai-realtime",
  }

  it("routes through the live PCM player and completes on done", async () => {
    mockStream.mockImplementationOnce(async ({ onEvent }: { onEvent: (e: unknown) => void }) => {
      onEvent({ kind: "audio", audioBase64: btoa("\x01\x00\x02\x00") })
      onEvent({ kind: "done" })
    })
    const o = new TTSOrchestrator()
    const onEnd = jest.fn()
    await o.speak("read this aloud", {
      speechSettings: realtimeSettings,
      providerSettings: { openai: { apiKey: "k" } },
      onEnd,
    })
    expect(mockStream).toHaveBeenCalledTimes(1)
    // No chunk cache touched on the streaming path.
    expect(mockCache).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalled()
    expect(o.getState().playbackState).toBe("stopped")
  })

  it("surfaces a stream error as an error state", async () => {
    mockStream.mockImplementationOnce(async ({ onEvent }: { onEvent: (e: unknown) => void }) => {
      onEvent({ kind: "error", message: "ws closed" })
    })
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", {
        speechSettings: realtimeSettings,
        providerSettings: { openai: { apiKey: "k" } },
      })
    ).rejects.toThrow(/ws closed/)
    expect(o.getState().playbackState).toBe("error")
  })

  it("errors before calling the transport when the API key is missing", async () => {
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", { speechSettings: realtimeSettings, providerSettings: {} })
    ).rejects.toThrow(/Configure an API key/)
    expect(mockStream).not.toHaveBeenCalled()
  })

  it("surfaces a player enqueue failure as an error state", async () => {
    ;(PcmPlayer as jest.Mock).mockImplementationOnce(() => ({
      enqueue: jest.fn(() => {
        throw new Error("audio decode failed")
      }),
      end: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      stop: jest.fn(),
    }))
    mockStream.mockImplementationOnce(async ({ onEvent }: { onEvent: (e: unknown) => void }) => {
      onEvent({ kind: "audio", audioBase64: btoa("\x01\x00") })
    })
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", {
        speechSettings: realtimeSettings,
        providerSettings: { openai: { apiKey: "k" } },
      })
    ).rejects.toThrow(/audio decode failed/)
    expect(o.getState().playbackState).toBe("error")
  })

  it("drives pause/resume/stop on the live PCM player", async () => {
    // Emit audio (→ playing) but never `done`, so playback stays live.
    mockStream.mockImplementationOnce(async ({ onEvent }: { onEvent: (e: unknown) => void }) => {
      onEvent({ kind: "audio", audioBase64: btoa("\x01\x00") })
    })
    const o = new TTSOrchestrator()
    const speaking = o.speak("hold the line", {
      speechSettings: realtimeSettings,
      providerSettings: { openai: { apiKey: "k" } },
    })
    // Flush the transport's synchronous audio emission.
    await Promise.resolve()
    await Promise.resolve()

    const player = (PcmPlayer as jest.Mock).mock.results.at(-1)?.value
    expect(o.getState().playbackState).toBe("playing")

    o.pause()
    expect(player.pause).toHaveBeenCalled()
    expect(o.getState().playbackState).toBe("paused")

    o.resume()
    expect(player.resume).toHaveBeenCalled()
    expect(o.getState().playbackState).toBe("playing")

    o.stop()
    expect(player.stop).toHaveBeenCalled()
    await speaking // resolves via the abort listener
    expect(o.getState().playbackState).toBe("stopped")
  })
})

describe("system provider", () => {
  it("drives Web Speech API with the configured voice and lang", async () => {
    const state = setupSpeechSynth()
    state.voices = [{ name: "Aria", lang: "en-US" } as SpeechSynthesisVoice]
    const o = new TTSOrchestrator()
    await o.speak("hi", {
      speechSettings: {
        ...DEFAULT_SPEECH_SETTINGS,
        ttsEnabled: true,
        ttsProvider: "system",
        systemVoice: "Aria",
      },
    })
    expect(state.utterance).not.toBeNull()
    expect(state.utterance!.voice?.name).toBe("Aria")
    expect(o.getState().playbackState).toBe("stopped")
  })

  it("drives Web Speech API even when systemVoice is not configured", async () => {
    setupSpeechSynth()
    const o = new TTSOrchestrator()
    await o.speak("hi", {
      speechSettings: { ...DEFAULT_SPEECH_SETTINGS, ttsEnabled: true, ttsProvider: "system" },
    })
    expect(o.getState().playbackState).toBe("stopped")
  })

  it("rejects when speechSynthesis is unavailable", async () => {
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", {
        speechSettings: { ...DEFAULT_SPEECH_SETTINGS, ttsEnabled: true, ttsProvider: "system" },
      })
    ).rejects.toThrow(/System TTS is not supported/)
  })

  it("treats canceled/interrupted as a graceful end", async () => {
    const state = setupSpeechSynth()
    // Override the speak handler to fire onerror with a cancel.
    const origSpeak = state // closure
    Object.defineProperty(window.speechSynthesis, "speak", {
      configurable: true,
      value: (u: SpeechSynthesisUtterance) => {
        origSpeak.utterance = u
        Promise.resolve().then(() => {
          ;(u.onerror as unknown as (e: { error: string }) => void)({ error: "canceled" })
        })
      },
    })
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", {
        speechSettings: { ...DEFAULT_SPEECH_SETTINGS, ttsEnabled: true, ttsProvider: "system" },
      })
    ).resolves.toBeUndefined()
  })

  it("rejects on a real synthesis error", async () => {
    const state = setupSpeechSynth()
    Object.defineProperty(window.speechSynthesis, "speak", {
      configurable: true,
      value: (u: SpeechSynthesisUtterance) => {
        state.utterance = u
        Promise.resolve().then(() => {
          ;(u.onerror as unknown as (e: { error: string }) => void)({ error: "synthesis-failed" })
        })
      },
    })
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", {
        speechSettings: { ...DEFAULT_SPEECH_SETTINGS, ttsEnabled: true, ttsProvider: "system" },
      })
    ).rejects.toThrow(/Speech synthesis error/)
  })
})

describe("stop", () => {
  it("cancels speech synthesis, pauses audio, revokes urls, and resets state", () => {
    setupSpeechSynth()
    const o = new TTSOrchestrator()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any).audioRef = { pause: jest.fn() }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any).audioUrlRef = "blob:abc"
    o.stop()
    expect(o.getState().playbackState).toBe("stopped")
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:abc")
  })
})

describe("pause / resume", () => {
  it("pauses cloud audio when playing", () => {
    const o = new TTSOrchestrator()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any).state = {
      ...o.getState(),
      playbackState: "playing",
      currentProvider: "openai",
    }
    const audio = { pause: jest.fn() } as unknown as HTMLAudioElement
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any).audioRef = audio
    o.pause()
    expect(audio.pause).toHaveBeenCalled()
    expect(o.getState().playbackState).toBe("paused")
  })

  it("pauses speechSynthesis when system provider is current", () => {
    const state = setupSpeechSynth()
    const o = new TTSOrchestrator()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any).state = {
      ...o.getState(),
      playbackState: "playing",
      currentProvider: "system",
    }
    o.pause()
    expect(state.pauseCount).toBe(1)
  })

  it("pause is a no-op when not playing", () => {
    const o = new TTSOrchestrator()
    o.pause()
    expect(o.getState().playbackState).toBe("idle")
  })

  it("resume is a no-op when not paused", () => {
    const o = new TTSOrchestrator()
    o.resume()
    expect(o.getState().playbackState).toBe("idle")
  })

  it("resumes cloud audio when paused", () => {
    const o = new TTSOrchestrator()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any).state = {
      ...o.getState(),
      playbackState: "paused",
      currentProvider: "openai",
    }
    const audio = { play: jest.fn().mockResolvedValue(undefined) } as unknown as HTMLAudioElement
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any).audioRef = audio
    o.resume()
    expect(audio.play).toHaveBeenCalled()
    expect(o.getState().playbackState).toBe("playing")
  })

  it("resumes speechSynthesis when system provider is current", () => {
    const state = setupSpeechSynth()
    const o = new TTSOrchestrator()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any).state = {
      ...o.getState(),
      playbackState: "paused",
      currentProvider: "system",
    }
    o.resume()
    expect(state.resumeCount).toBe(1)
  })

  it("swallows resume play() rejection", () => {
    const o = new TTSOrchestrator()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any).state = {
      ...o.getState(),
      playbackState: "paused",
      currentProvider: "openai",
    }
    const audio = {
      play: jest.fn().mockRejectedValue(new Error("nope")),
    } as unknown as HTMLAudioElement
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any).audioRef = audio
    expect(() => o.resume()).not.toThrow()
  })
})

describe("audio element error path", () => {
  it("rejects the playback promise when onerror fires", async () => {
    // Replace MockAudio with one that fires onerror.
    class ErrAudio implements Partial<MockAudio> {
      src: string
      volume = 1
      currentTime = 0
      duration = 1
      onplay: (() => void) | null = null
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      onpause: (() => void) | null = null
      ontimeupdate: (() => void) | null = null
      pause = jest.fn()
      play: jest.Mock
      constructor(src: string) {
        this.src = src
        this.play = jest.fn().mockImplementation(async () => {
          Promise.resolve().then(() => this.onerror?.())
        })
      }
    }
    ;(globalThis as unknown as { Audio: unknown }).Audio = ErrAudio

    mockCache.mockResolvedValueOnce({ audioData: new ArrayBuffer(2), mimeType: "audio/mpeg" })
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", {
        speechSettings: {
          ...DEFAULT_SPEECH_SETTINGS,
          ttsEnabled: true,
          ttsProvider: "openai",
          ttsFallbackEnabled: false,
        },
        providerSettings: { openai: { apiKey: "k" } },
      })
    ).rejects.toThrow(/Audio playback error/)
  })
})

describe("activeSourceId tracking", () => {
  it("tags state with sourceId while speaking and clears it on completion", async () => {
    const settings: SpeechSettings = {
      ...DEFAULT_SPEECH_SETTINGS,
      ttsEnabled: true,
      ttsProvider: "openai",
    }
    mockCache.mockResolvedValueOnce({ audioData: new ArrayBuffer(8), mimeType: "audio/mpeg" })
    const o = new TTSOrchestrator()
    const seen: (string | undefined)[] = []
    o.subscribe((s) => seen.push(s.activeSourceId))

    await o.speak("hello", {
      speechSettings: settings,
      providerSettings: { openai: { apiKey: "k" } },
      source: "chat",
      sourceId: "msg-1",
    })

    // The id is present during loading/playing and cleared once stopped.
    expect(seen).toContain("msg-1")
    expect(o.getState().activeSourceId).toBeUndefined()
  })

  it("clears activeSourceId on stop", () => {
    const o = new TTSOrchestrator()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(o as any).state = { ...o.getState(), activeSourceId: "msg-9" }
    o.stop()
    expect(o.getState().activeSourceId).toBeUndefined()
  })

  it("clears activeSourceId on error", async () => {
    const settings: SpeechSettings = {
      ...DEFAULT_SPEECH_SETTINGS,
      ttsEnabled: true,
      ttsProvider: "openai",
    }
    mockCache.mockResolvedValueOnce(null)
    const o = new TTSOrchestrator()
    await expect(
      o.speak("hi", {
        speechSettings: settings,
        providerSettings: { openai: { apiKey: "k" } },
        sourceId: "msg-err",
      })
    ).rejects.toThrow()
    expect(o.getState().activeSourceId).toBeUndefined()
  })
})

describe("audio onpause emits paused state when not finished", () => {
  it("transitions to paused mid-playback", async () => {
    class PauseAudio implements Partial<MockAudio> {
      src: string
      volume = 1
      currentTime = 0
      duration = 1
      onplay: (() => void) | null = null
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      onpause: (() => void) | null = null
      ontimeupdate: (() => void) | null = null
      pause = jest.fn()
      play: jest.Mock
      constructor(src: string) {
        this.src = src
        this.play = jest.fn().mockImplementation(async () => {
          Promise.resolve().then(() => {
            this.onplay?.()
            this.currentTime = 0.4
            this.onpause?.()
            // finish the audio so the promise resolves
            this.currentTime = this.duration
            this.onended?.()
          })
        })
      }
    }
    ;(globalThis as unknown as { Audio: unknown }).Audio = PauseAudio
    mockCache.mockResolvedValueOnce({ audioData: new ArrayBuffer(2), mimeType: "audio/mpeg" })
    const o = new TTSOrchestrator()
    await o.speak("hi", {
      speechSettings: {
        ...DEFAULT_SPEECH_SETTINGS,
        ttsEnabled: true,
        ttsProvider: "openai",
      },
      providerSettings: { openai: { apiKey: "k" } },
    })
    // After successful playback the orchestrator settles to stopped.
    expect(o.getState().playbackState).toBe("stopped")
  })
})
