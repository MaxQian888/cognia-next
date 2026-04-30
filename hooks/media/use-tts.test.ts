/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

interface OrchestratorState {
  playbackState: "idle" | "loading" | "playing" | "paused" | "error"
  progress: number
  error: string | null
  isLoading: boolean
  isPlaying: boolean
  isPaused: boolean
  activeRequestId?: string
  activeSource?: string
}

const orchestratorState: OrchestratorState = {
  playbackState: "idle",
  progress: 0,
  error: null,
  isLoading: false,
  isPlaying: false,
  isPaused: false,
}

const speakMock = jest.fn().mockResolvedValue(undefined)
const stopMock = jest.fn()
const pauseMock = jest.fn()
const resumeMock = jest.fn()
const subscribers: Array<(s: OrchestratorState) => void> = []

jest.mock("@/lib/tts/tts-orchestrator", () => ({
  ttsOrchestrator: {
    getState: () => orchestratorState,
    subscribe: (fn: (s: OrchestratorState) => void) => {
      subscribers.push(fn)
      return () => {
        const i = subscribers.indexOf(fn)
        if (i >= 0) subscribers.splice(i, 1)
      }
    },
    speak: (text: string, opts: unknown) => speakMock(text, opts),
    stop: () => stopMock(),
    pause: () => pauseMock(),
    resume: () => resumeMock(),
  },
}))

jest.mock("@/lib/tts/speech-settings", () => ({
  selectSpeechSettings: () => ({ ttsProvider: "openai", voice: "v" }),
}))

jest.mock("@/lib/tts/keyring", () => ({
  providerKeyMapToSettingsMap: (k: unknown) => ({ openai: { apiKey: "k", value: k } }),
}))

jest.mock("@/lib/tts/types", () => ({
  DEFAULT_SPEECH_SETTINGS: { ttsProvider: "system" },
}))

const settingsState = {
  settings: { ttsProvider: "openai" },
  providerKeys: { openai: "k" },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T>(selector: (s: typeof settingsState) => T): T => selector(settingsState),
}))

import { useTTS } from "./use-tts"

beforeEach(() => {
  speakMock.mockClear()
  stopMock.mockClear()
  pauseMock.mockClear()
  resumeMock.mockClear()
  subscribers.length = 0
  orchestratorState.playbackState = "idle"
  orchestratorState.progress = 0
  orchestratorState.error = null
  orchestratorState.isLoading = false
  orchestratorState.isPlaying = false
  orchestratorState.isPaused = false
})

describe("useTTS", () => {
  it("forwards default settings to orchestrator.speak", async () => {
    const { result } = renderHook(() => useTTS({ source: "chat" }))
    await act(async () => {
      await result.current.speak("hi")
    })
    expect(speakMock).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({
        provider: "openai",
        source: "chat",
      })
    )
  })

  it("respects provider override on the speak call", async () => {
    const { result } = renderHook(() => useTTS())
    await act(async () => {
      await result.current.speak("hi", "elevenlabs")
    })
    expect(speakMock).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ provider: "elevenlabs" })
    )
  })

  it("respects useSettings:false branch (uses defaults)", async () => {
    const { result } = renderHook(() => useTTS({ useSettings: false }))
    expect(result.current.currentProvider).toBe("system")
  })

  it("wires stop/pause/resume to orchestrator", () => {
    const { result } = renderHook(() => useTTS())
    act(() => {
      result.current.stop()
      result.current.pause()
      result.current.resume()
    })
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(pauseMock).toHaveBeenCalledTimes(1)
    expect(resumeMock).toHaveBeenCalledTimes(1)
  })

  it("re-renders when orchestrator publishes a new state", () => {
    const { result } = renderHook(() => useTTS())
    expect(result.current.isPlaying).toBe(false)
    act(() => {
      const next = { ...orchestratorState, isPlaying: true, playbackState: "playing" as const }
      Object.assign(orchestratorState, next)
      subscribers.forEach((s) => s(next))
    })
    expect(result.current.isPlaying).toBe(true)
    expect(result.current.playbackState).toBe("playing")
  })

  it("isSupported is false for system provider when speechSynthesis is missing", () => {
    const original = "speechSynthesis" in window
    if (original) {
      delete (window as { speechSynthesis?: unknown }).speechSynthesis
    }
    const { result } = renderHook(() => useTTS({ provider: "system" }))
    expect(result.current.isSupported).toBe(false)
  })

  it("isSupported is true for non-system provider regardless of speechSynthesis", () => {
    const { result } = renderHook(() => useTTS({ provider: "openai" }))
    expect(result.current.isSupported).toBe(true)
  })

  it("isSupported is true for system provider when speechSynthesis is present", () => {
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      writable: true,
      value: {},
    })
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      writable: true,
      value: class {},
    })
    const { result } = renderHook(() => useTTS({ provider: "system" }))
    expect(result.current.isSupported).toBe(true)
  })

  it("unsubscribes from orchestrator on unmount", () => {
    const { unmount } = renderHook(() => useTTS())
    expect(subscribers.length).toBe(1)
    unmount()
    expect(subscribers.length).toBe(0)
  })
})
