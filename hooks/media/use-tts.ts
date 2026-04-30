"use client"

/**
 * useTTS — React hook over the singleton TTS orchestrator.
 *
 * Ported from `D:\Project\Cognia\hooks\media\use-tts.ts`. The cognia-next
 * version reads `speechSettings` and `providerSettings` from
 * `useSettingsStore` instead of Cognia's monolithic Zustand store, but the
 * external API is identical.
 */

import { useCallback, useEffect, useState } from "react"

import { useSettingsStore } from "@/stores/settings"
import { selectSpeechSettings } from "@/lib/tts/speech-settings"
import {
  ttsOrchestrator,
  type TTSActiveSource,
  type TTSOrchestratorState,
} from "@/lib/tts/tts-orchestrator"
import { providerKeyMapToSettingsMap } from "@/lib/tts/keyring"
import { DEFAULT_SPEECH_SETTINGS, type TTSPlaybackState, type TTSProvider } from "@/lib/tts/types"

export interface UseTTSOptions {
  /** Use settings from store (default: true). False uses defaults only. */
  useSettings?: boolean
  /** Override the active provider (otherwise pulled from settings). */
  provider?: TTSProvider
  /** Tag attached to orchestrator state for cancellation arbitration. */
  source?: TTSActiveSource
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
    source = "unknown",
    onStart,
    onEnd,
    onError,
    onProgress,
  } = options

  const settings = useSettingsStore((s) => s.settings)
  const providerKeys = useSettingsStore((s) => s.providerKeys)

  const speechSettings = useSettings ? selectSpeechSettings(settings) : DEFAULT_SPEECH_SETTINGS
  const providerSettings = providerKeyMapToSettingsMap(providerKeys)

  const currentProvider: TTSProvider =
    provider ?? (useSettings ? speechSettings.ttsProvider : "system")

  const [orchState, setOrchState] = useState<TTSOrchestratorState>(ttsOrchestrator.getState())

  useEffect(() => {
    return ttsOrchestrator.subscribe(setOrchState)
  }, [])

  const speak = useCallback(
    async (text: string, overrideProvider?: TTSProvider): Promise<void> => {
      const active = overrideProvider ?? currentProvider
      await ttsOrchestrator.speak(text, {
        provider: active,
        source,
        speechSettings,
        providerSettings,
        onStart,
        onEnd,
        onError,
        onProgress,
      })
    },
    [currentProvider, source, speechSettings, providerSettings, onStart, onEnd, onError, onProgress]
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
    speak,
    stop: () => ttsOrchestrator.stop(),
    pause: () => ttsOrchestrator.pause(),
    resume: () => ttsOrchestrator.resume(),
    currentProvider,
    isSupported,
  }
}

export default useTTS
