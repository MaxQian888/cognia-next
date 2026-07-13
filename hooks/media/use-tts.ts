"use client"

/**
 * useTTS — React hook over the singleton TTS orchestrator.
 *
 * Ported from `D:\Project\Cognia\hooks\media\use-tts.ts`. The cognia-next
 * version reads `speechSettings` and `providerSettings` from
 * `useSettingsStore` instead of Cognia's monolithic Zustand store, but the
 * external API is identical.
 */

import { useCallback, useEffect, useMemo, useState } from "react"

import { useSettingsStore } from "@/stores/settings"
import { selectSpeechSettings } from "@/lib/tts/speech-settings"
import {
  ttsOrchestrator,
  type TTSActiveSource,
  type TTSOrchestratorState,
} from "@/lib/tts/tts-orchestrator"
import { providerKeyMapToSettingsMap } from "@/lib/tts/keyring"
import {
  DEFAULT_SPEECH_SETTINGS,
  type SpeechSettings,
  type TTSPlaybackState,
  type TTSProvider,
} from "@cognia/tts/types"

export interface UseTTSOptions {
  /** Use settings from store (default: true). False uses defaults only. */
  useSettings?: boolean
  /** Override the active provider (otherwise pulled from settings). */
  provider?: TTSProvider
  /**
   * Partial SpeechSettings overlay spread on top of the settings-derived base
   * before each `speak`. Used to audition a per-character `voiceProfile`
   * (see `lib/plugin/character-pack/character-voice.ts:resolveCharacterVoice`)
   * without mutating global AppSettings. Its `ttsProvider`, when set, also
   * drives the active provider.
   */
  voiceOverlay?: Partial<SpeechSettings>
  /** Tag attached to orchestrator state for cancellation arbitration. */
  source?: TTSActiveSource
  /**
   * Opaque id for the surface that initiates playback (e.g. a chat message
   * id). Surfaced back as `activeSourceId` so a per-item control can tell
   * whether it owns the currently-playing audio.
   */
  sourceId?: string
  onStart?: () => void
  onEnd?: () => void
  onError?: (error: string) => void
  onProgress?: (progress: number) => void
}

export interface UseTTSReturn {
  isLoading: boolean
  isPlaying: boolean
  isPaused: boolean
  playbackState: TTSPlaybackState
  progress: number
  error: string | null
  activeRequestId?: string
  activeSource?: TTSActiveSource
  activeSourceId?: string
  speak: (text: string, overrideProvider?: TTSProvider) => Promise<void>
  stop: () => void
  pause: () => void
  resume: () => void
  currentProvider: TTSProvider
  isSupported: boolean
}

export function useTTS(options: UseTTSOptions = {}): UseTTSReturn {
  const {
    useSettings = true,
    provider,
    voiceOverlay,
    source = "unknown",
    sourceId,
    onStart,
    onEnd,
    onError,
    onProgress,
  } = options

  const settings = useSettingsStore((s) => s.settings)

  const baseSpeech = useMemo(
    () => (useSettings ? selectSpeechSettings(settings) : DEFAULT_SPEECH_SETTINGS),
    [useSettings, settings]
  )
  // Spread the per-character overlay (if any) on top of the global base.
  const speechSettings: SpeechSettings = useMemo(
    () => (voiceOverlay ? { ...baseSpeech, ...voiceOverlay } : baseSpeech),
    [voiceOverlay, baseSpeech]
  )

  const currentProvider: TTSProvider =
    provider ?? (useSettings ? speechSettings.ttsProvider : (voiceOverlay?.ttsProvider ?? "system"))

  const [orchState, setOrchState] = useState<TTSOrchestratorState>(ttsOrchestrator.getState())

  useEffect(() => {
    return ttsOrchestrator.subscribe(setOrchState)
  }, [])

  const speak = useCallback(
    async (text: string, overrideProvider?: TTSProvider): Promise<void> => {
      const active = overrideProvider ?? currentProvider
      // Lazily load TTS provider keys on first actual playback — they're no
      // longer fetched during app boot. Read the freshest keys straight from
      // the store after the (idempotent) load so even the very first `speak`
      // sees them, regardless of render timing.
      await useSettingsStore.getState().ensureProviderKeys()
      const providerSettings = providerKeyMapToSettingsMap(useSettingsStore.getState().providerKeys)
      await ttsOrchestrator.speak(text, {
        provider: active,
        source,
        sourceId,
        speechSettings,
        providerSettings,
        onStart,
        onEnd,
        onError,
        onProgress,
      })
    },
    [currentProvider, source, sourceId, speechSettings, onStart, onEnd, onError, onProgress]
  )

  const isSupported =
    typeof window !== "undefined" &&
    (currentProvider !== "system" ||
      ("speechSynthesis" in window && "SpeechSynthesisUtterance" in window))

  return {
    isLoading: orchState.isLoading,
    isPlaying: orchState.isPlaying,
    isPaused: orchState.isPaused,
    playbackState: orchState.playbackState,
    progress: orchState.progress,
    error: orchState.error,
    activeRequestId: orchState.activeRequestId,
    activeSource: orchState.activeSource,
    activeSourceId: orchState.activeSourceId,
    speak,
    stop: () => ttsOrchestrator.stop(),
    pause: () => ttsOrchestrator.pause(),
    resume: () => ttsOrchestrator.resume(),
    currentProvider,
    isSupported,
  }
}

export default useTTS
