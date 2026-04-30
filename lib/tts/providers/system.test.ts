/**
 * Tests for the System (Web Speech API) TTS helpers. Stubs
 * `window.speechSynthesis` and `window.SpeechSynthesisUtterance` so the
 * helpers can drive them without a real speech engine.
 */

import {
  findSystemVoice,
  generateSystemTTSAudio,
  getSystemVoices,
  isSystemTTSPaused,
  isSystemTTSSpeaking,
  isSystemTTSSupported,
  speakWithSystemTTS,
  stopSystemTTS,
  waitForVoices,
} from "./system"

interface MockUtterance {
  text: string
  voice: SpeechSynthesisVoice | null
  rate: number
  pitch: number
  volume: number
  lang: string
  onstart: ((this: SpeechSynthesisUtterance) => unknown) | null
  onend: ((this: SpeechSynthesisUtterance) => unknown) | null
  onerror: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisErrorEvent) => unknown) | null
  onpause: ((this: SpeechSynthesisUtterance) => unknown) | null
  onresume: ((this: SpeechSynthesisUtterance) => unknown) | null
  onboundary: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null
}

interface MockSynthesis {
  paused: boolean
  speaking: boolean
  onvoiceschanged: ((this: SpeechSynthesis, ev: Event) => unknown) | null
  voices: SpeechSynthesisVoice[]
  speakCalls: MockUtterance[]
  cancelCount: number
  pauseCount: number
  resumeCount: number
}

function setupSpeech({
  voices = [] as Partial<SpeechSynthesisVoice>[],
}: { voices?: Partial<SpeechSynthesisVoice>[] } = {}): MockSynthesis {
  const filled = voices.map(
    (v) =>
      ({
        name: "",
        voiceURI: "",
        lang: "en-US",
        default: false,
        localService: true,
        ...v,
      }) as SpeechSynthesisVoice
  )

  const state: MockSynthesis = {
    paused: false,
    speaking: false,
    onvoiceschanged: null,
    voices: filled,
    speakCalls: [],
    cancelCount: 0,
    pauseCount: 0,
    resumeCount: 0,
  }

  const synth = {
    get paused() {
      return state.paused
    },
    get speaking() {
      return state.speaking
    },
    set onvoiceschanged(fn: typeof state.onvoiceschanged) {
      state.onvoiceschanged = fn
    },
    get onvoiceschanged() {
      return state.onvoiceschanged
    },
    getVoices: () => state.voices,
    cancel: () => {
      state.cancelCount++
      state.speaking = false
    },
    pause: () => {
      state.pauseCount++
      state.paused = true
    },
    resume: () => {
      state.resumeCount++
      state.paused = false
    },
    speak: (utt: MockUtterance) => {
      state.speakCalls.push(utt)
      state.speaking = true
    },
  }

  ;(window as unknown as { speechSynthesis: typeof synth }).speechSynthesis = synth
  ;(globalThis as unknown as { speechSynthesis: typeof synth }).speechSynthesis = synth

  class MockUtteranceCtor {
    text: string
    voice: SpeechSynthesisVoice | null = null
    rate = 1
    pitch = 1
    volume = 1
    lang = ""
    onstart: MockUtterance["onstart"] = null
    onend: MockUtterance["onend"] = null
    onerror: MockUtterance["onerror"] = null
    onpause: MockUtterance["onpause"] = null
    onresume: MockUtterance["onresume"] = null
    onboundary: MockUtterance["onboundary"] = null
    constructor(text: string) {
      this.text = text
    }
  }
  ;(
    window as unknown as { SpeechSynthesisUtterance: typeof MockUtteranceCtor }
  ).SpeechSynthesisUtterance = MockUtteranceCtor

  return state
}

function teardownSpeech() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).speechSynthesis
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).SpeechSynthesisUtterance
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).speechSynthesis
}

afterEach(() => teardownSpeech())

describe("isSystemTTSSupported", () => {
  it("returns true when both APIs are present", () => {
    setupSpeech()
    expect(isSystemTTSSupported()).toBe(true)
  })

  it("returns false when SpeechSynthesisUtterance is missing", () => {
    setupSpeech()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).SpeechSynthesisUtterance
    expect(isSystemTTSSupported()).toBe(false)
  })
})

describe("getSystemVoices", () => {
  it("returns [] when not supported", () => {
    expect(getSystemVoices()).toEqual([])
  })

  it("returns the voices reported by the engine", () => {
    setupSpeech({ voices: [{ name: "v1" }, { name: "v2" }] })
    expect(getSystemVoices()).toHaveLength(2)
  })
})

describe("waitForVoices", () => {
  it("resolves immediately when voices are available", async () => {
    setupSpeech({ voices: [{ name: "v" }] })
    await expect(waitForVoices()).resolves.toHaveLength(1)
  })

  it("resolves [] when not supported", async () => {
    await expect(waitForVoices()).resolves.toEqual([])
  })

  it("waits for onvoiceschanged when initial list is empty", async () => {
    const state = setupSpeech({ voices: [] })
    const promise = waitForVoices()
    // Populate then trigger the callback the way the engine would.
    state.voices = [{ name: "delayed" } as SpeechSynthesisVoice]
    state.onvoiceschanged?.(new Event("voiceschanged"))
    await expect(promise).resolves.toHaveLength(1)
  })

  it("falls back via timeout when voices never arrive", async () => {
    jest.useFakeTimers()
    setupSpeech({ voices: [] })
    const promise = waitForVoices()
    jest.advanceTimersByTime(3000)
    await expect(promise).resolves.toEqual([])
    jest.useRealTimers()
  })
})

describe("findSystemVoice", () => {
  it("returns null when there are no voices", () => {
    setupSpeech({ voices: [] })
    expect(findSystemVoice("nope")).toBeNull()
  })

  it("matches by name", () => {
    setupSpeech({
      voices: [
        { name: "Aria", lang: "en-US" },
        { name: "Ji", lang: "zh-CN" },
      ],
    })
    const v = findSystemVoice("Aria")
    expect(v?.name).toBe("Aria")
  })

  it("matches by voiceURI", () => {
    setupSpeech({
      voices: [{ name: "Aria", voiceURI: "uri-1", lang: "en-US" }],
    })
    expect(findSystemVoice("uri-1")?.voiceURI).toBe("uri-1")
  })

  it("falls back to language prefix", () => {
    setupSpeech({
      voices: [
        { name: "Ji", lang: "zh-CN" },
        { name: "Aria", lang: "en-US" },
      ],
    })
    expect(findSystemVoice(undefined, "zh-CN")?.name).toBe("Ji")
  })

  it("returns the first voice when name and lang both miss", () => {
    setupSpeech({ voices: [{ name: "First", lang: "en-US" }] })
    expect(findSystemVoice("missing", "fr-FR")?.name).toBe("First")
  })
})

describe("speakWithSystemTTS", () => {
  it("returns a controller and calls onError when not supported", async () => {
    const ctrl = speakWithSystemTTS("hi")
    const err: { type?: string }[] = []
    ctrl.onError = (e) => err.push(e)
    // Wait for the queued setTimeout to fire.
    await new Promise((r) => setTimeout(r, 0))
    expect(err[0].type).toBe("not-supported")
  })

  it("speaks the utterance, applying provided voice/rate/pitch/volume/lang", () => {
    const state = setupSpeech({
      voices: [{ name: "Aria", lang: "en-US" }],
    })
    const ctrl = speakWithSystemTTS("hello", {
      voice: "Aria",
      rate: 1.4,
      pitch: 0.9,
      volume: 0.6,
      lang: "en-US",
    })
    expect(state.cancelCount).toBe(1)
    expect(state.speakCalls).toHaveLength(1)
    const utt = state.speakCalls[0]
    expect(utt.text).toBe("hello")
    expect(utt.rate).toBe(1.4)
    expect(utt.pitch).toBe(0.9)
    expect(utt.volume).toBe(0.6)
    expect(utt.voice?.name).toBe("Aria")
    expect(utt.lang).toBe("en-US")
    ctrl.cancel()
  })

  it("falls back to a lang-only voice when no voice was specified but lang is", () => {
    const state = setupSpeech({ voices: [{ name: "Henri", lang: "fr-FR" }] })
    speakWithSystemTTS("salut", { lang: "fr-FR" })
    expect(state.speakCalls[0].voice?.name).toBe("Henri")
  })

  it("uses default rate/pitch/volume when not specified", () => {
    const state = setupSpeech()
    speakWithSystemTTS("hi")
    const utt = state.speakCalls[0]
    expect(utt.rate).toBe(1)
    expect(utt.pitch).toBe(1)
    expect(utt.volume).toBe(1)
  })

  it("dispatches lifecycle callbacks through the controller", () => {
    const state = setupSpeech()
    const ctrl = speakWithSystemTTS("hi")
    const onStart = jest.fn()
    const onEnd = jest.fn()
    const onPause = jest.fn()
    const onResume = jest.fn()
    const onBoundary = jest.fn()
    ctrl.onStart = onStart
    ctrl.onEnd = onEnd
    ctrl.onPause = onPause
    ctrl.onResume = onResume
    ctrl.onBoundary = onBoundary

    const utt = state.speakCalls[0]
    utt.onstart?.call(utt as unknown as SpeechSynthesisUtterance)
    utt.onend?.call(utt as unknown as SpeechSynthesisUtterance)
    utt.onpause?.call(utt as unknown as SpeechSynthesisUtterance)
    utt.onresume?.call(utt as unknown as SpeechSynthesisUtterance)
    utt.onboundary?.call(
      utt as unknown as SpeechSynthesisUtterance,
      { name: "word" } as SpeechSynthesisEvent
    )
    expect(onStart).toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalled()
    expect(onPause).toHaveBeenCalled()
    expect(onResume).toHaveBeenCalled()
    expect(onBoundary).toHaveBeenCalled()
  })

  it("classifies cancel/interrupt as a 'cancelled' error", () => {
    const state = setupSpeech()
    const ctrl = speakWithSystemTTS("hi")
    const errors: { type?: string }[] = []
    ctrl.onError = (e) => errors.push(e)
    const utt = state.speakCalls[0]
    utt.onerror?.call(
      utt as unknown as SpeechSynthesisUtterance,
      { error: "canceled" } as SpeechSynthesisErrorEvent
    )
    utt.onerror?.call(
      utt as unknown as SpeechSynthesisUtterance,
      { error: "interrupted" } as SpeechSynthesisErrorEvent
    )
    expect(errors).toHaveLength(2)
    expect(errors[0].type).toBe("cancelled")
    expect(errors[1].type).toBe("cancelled")
  })

  it("classifies non-cancel errors as audio-playback-error", () => {
    const state = setupSpeech()
    const ctrl = speakWithSystemTTS("hi")
    const errors: { type?: string; details?: string }[] = []
    ctrl.onError = (e) => errors.push(e)
    const utt = state.speakCalls[0]
    utt.onerror?.call(
      utt as unknown as SpeechSynthesisUtterance,
      { error: "synthesis-failed" } as SpeechSynthesisErrorEvent
    )
    expect(errors[0].type).toBe("audio-playback-error")
    expect(errors[0].details).toBe("synthesis-failed")
  })

  it("controller pause/resume/cancel proxy to speechSynthesis", () => {
    const state = setupSpeech()
    const ctrl = speakWithSystemTTS("hi")
    ctrl.pause()
    ctrl.resume()
    ctrl.cancel()
    expect(state.pauseCount).toBe(1)
    expect(state.resumeCount).toBe(1)
    expect(state.cancelCount).toBeGreaterThanOrEqual(2) // at least the speakWithSystemTTS call + cancel()
  })
})

describe("stopSystemTTS", () => {
  it("cancels when supported", () => {
    const state = setupSpeech()
    stopSystemTTS()
    expect(state.cancelCount).toBe(1)
  })

  it("is a no-op when not supported", () => {
    expect(() => stopSystemTTS()).not.toThrow()
  })
})

describe("isSystemTTSSpeaking / isSystemTTSPaused", () => {
  it("return false when not supported", () => {
    expect(isSystemTTSSpeaking()).toBe(false)
    expect(isSystemTTSPaused()).toBe(false)
  })

  it("reflect the engine state", () => {
    const state = setupSpeech()
    state.speaking = true
    state.paused = true
    expect(isSystemTTSSpeaking()).toBe(true)
    expect(isSystemTTSPaused()).toBe(true)
  })
})

describe("generateSystemTTSAudio", () => {
  it("always returns a not-supported error", async () => {
    const r = await generateSystemTTSAudio()
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/audio file generation/)
  })
})
