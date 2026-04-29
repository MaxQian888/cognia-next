/**
 * TTS orchestrator — singleton wrapper around all 9 providers.
 *
 * Ported from `D:\Project\Cognia\lib\ai\tts\tts-orchestrator.ts`. The
 * cognia-next port drops the `/api/tts/<x>` route fallback (no server
 * under static export) and routes Edge-TTS through the Tauri WS bridge.
 * Direct provider calls (with a user-supplied API key) and the
 * caching/chunking/cancellation pipeline are preserved 1:1.
 */

import { toast } from "sonner"

import { generateCacheKey, getCachedOrGenerate } from "@/lib/tts/tts-cache"
import { getProviderRuntimeOptions, toTTSSettings } from "@/lib/tts/speech-settings"
import { preprocessTextForProvider, splitTextForTTS } from "@/lib/tts/tts-text-utils"
import {
  DEFAULT_SPEECH_SETTINGS,
  TTS_PROVIDERS,
  type ProviderSettingsMap,
  type SpeechSettings,
  type TTSPlaybackState,
  type TTSProvider,
  type TTSResponse,
} from "@/lib/tts/types"

import { generateOpenAITTS } from "@/lib/tts/providers/openai"
import { generateGeminiTTS } from "@/lib/tts/providers/gemini"
import { generateEdgeTTS } from "@/lib/tts/providers/edge"
import { generateElevenLabsTTS } from "@/lib/tts/providers/elevenlabs"
import { generateLMNTTTS } from "@/lib/tts/providers/lmnt"
import { generateHumeTTS } from "@/lib/tts/providers/hume"
import { generateCartesiaTTS } from "@/lib/tts/providers/cartesia"
import { generateDeepgramTTS } from "@/lib/tts/providers/deepgram"

export type TTSActiveSource = "chat" | "chat-widget" | "selection" | "settings" | "unknown"

export interface TTSOrchestratorState {
  playbackState: TTSPlaybackState
  progress: number
  error: string | null
  isLoading: boolean
  isPlaying: boolean
  isPaused: boolean
  currentProvider: TTSProvider
  activeRequestId?: string
  activeSource?: TTSActiveSource
}

export interface TTSOrchestratorSpeakOptions {
  provider?: TTSProvider
  source?: TTSActiveSource
  speechSettings?: SpeechSettings
  providerSettings?: ProviderSettingsMap
  onStart?: () => void
  onEnd?: () => void
  onError?: (error: string) => void
  onProgress?: (progress: number) => void
}

type Subscriber = (state: TTSOrchestratorState) => void

const DEFAULT_STATE: TTSOrchestratorState = {
  playbackState: "idle",
  progress: 0,
  error: null,
  isLoading: false,
  isPlaying: false,
  isPaused: false,
  currentProvider: "system",
  activeSource: "unknown",
}

export class TTSOrchestrator {
  private state: TTSOrchestratorState = { ...DEFAULT_STATE }
  private subscribers = new Set<Subscriber>()
  private audioRef: HTMLAudioElement | null = null
  private audioUrlRef: string | null = null
  private activeRequestId: string | null = null

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber)
    subscriber(this.state)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  getState(): TTSOrchestratorState {
    return this.state
  }

  async speak(text: string, options: TTSOrchestratorSpeakOptions = {}): Promise<void> {
    const speechSettings = options.speechSettings ?? DEFAULT_SPEECH_SETTINGS
    const providerSettings = options.providerSettings
    const provider = options.provider ?? speechSettings.ttsProvider
    const source = options.source ?? "unknown"

    if (!speechSettings.ttsEnabled) {
      this.setState({
        playbackState: "stopped",
        isLoading: false,
        isPlaying: false,
        isPaused: false,
        error: null,
        progress: 0,
      })
      return
    }

    this.stop()

    const requestId = this.createRequestId()
    this.activeRequestId = requestId
    this.setState({
      playbackState: "loading",
      isLoading: true,
      isPlaying: false,
      isPaused: false,
      progress: 0,
      error: null,
      currentProvider: provider,
      activeRequestId: requestId,
      activeSource: source,
    })

    const normalizedText = preprocessTextForProvider(text, provider)
    const chunks = splitTextForTTS(normalizedText, provider)

    try {
      options.onStart?.()

      for (let index = 0; index < chunks.length; index++) {
        if (!this.isCurrentRequest(requestId)) return
        const chunk = chunks[index]
        const base = index / chunks.length
        const weight = 1 / chunks.length

        if (provider === "system") {
          await this.playSystemChunk(chunk, speechSettings, requestId, (p) =>
            this.updateProgress(base + p * weight, options.onProgress)
          )
          continue
        }

        const response = await this.generateChunkAudio({
          provider,
          chunk,
          speechSettings,
          providerSettings,
        })

        if (!response.success || !response.audioData) {
          throw new Error(response.error || "Failed to generate speech audio")
        }

        await this.playAudioResponse(response, requestId, speechSettings.ttsVolume, (p) =>
          this.updateProgress(base + p * weight, options.onProgress)
        )
      }

      if (this.isCurrentRequest(requestId)) {
        this.setState({
          playbackState: "stopped",
          isLoading: false,
          isPlaying: false,
          isPaused: false,
          progress: 1,
          activeRequestId: undefined,
          activeSource: undefined,
        })
        options.onEnd?.()
      }
    } catch (error) {
      if (!this.isCurrentRequest(requestId)) return
      const message = error instanceof Error ? error.message : "Failed to generate speech"
      this.setState({
        playbackState: "error",
        isLoading: false,
        isPlaying: false,
        isPaused: false,
        error: message,
        activeRequestId: undefined,
        activeSource: undefined,
      })
      options.onError?.(message)
      toast.error(message)
      throw error
    } finally {
      if (this.isCurrentRequest(requestId)) {
        this.activeRequestId = null
      }
    }
  }

  stop(): void {
    this.activeRequestId = null
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel()
    }
    if (this.audioRef) {
      this.audioRef.pause()
      this.audioRef = null
    }
    if (this.audioUrlRef) {
      URL.revokeObjectURL(this.audioUrlRef)
      this.audioUrlRef = null
    }
    this.setState({
      playbackState: "stopped",
      isLoading: false,
      isPlaying: false,
      isPaused: false,
      progress: 0,
      activeRequestId: undefined,
      activeSource: undefined,
    })
  }

  pause(): void {
    if (this.state.playbackState !== "playing") return
    if (
      this.state.currentProvider === "system" &&
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    ) {
      window.speechSynthesis.pause()
    } else if (this.audioRef) {
      this.audioRef.pause()
    }
    this.setState({
      playbackState: "paused",
      isPlaying: false,
      isPaused: true,
      isLoading: false,
    })
  }

  resume(): void {
    if (this.state.playbackState !== "paused") return
    if (
      this.state.currentProvider === "system" &&
      typeof window !== "undefined" &&
      "speechSynthesis" in window
    ) {
      window.speechSynthesis.resume()
    } else if (this.audioRef) {
      void this.audioRef.play().catch(() => {})
    }
    this.setState({
      playbackState: "playing",
      isPlaying: true,
      isPaused: false,
      isLoading: false,
    })
  }

  private async generateChunkAudio(params: {
    provider: TTSProvider
    chunk: string
    speechSettings: SpeechSettings
    providerSettings: ProviderSettingsMap
  }): Promise<TTSResponse> {
    const { provider, chunk, speechSettings, providerSettings } = params
    const apiKey = this.getApiKey(provider, providerSettings)
    const ttsSettings = toTTSSettings(speechSettings)
    const runtimeOptions = getProviderRuntimeOptions(speechSettings, provider)

    const cacheKey = generateCacheKey(chunk, provider, ttsSettings)
    const cached = await getCachedOrGenerate(
      cacheKey,
      async () => {
        const generated = await this.generateUncached(provider, chunk, runtimeOptions, apiKey)
        if (!generated.success || !generated.audioData) return null
        return {
          audioData: generated.audioData,
          mimeType: generated.mimeType ?? "audio/mpeg",
        }
      },
      provider,
      chunk,
      speechSettings.ttsCacheEnabled
    )

    if (!cached) {
      return { success: false, error: "Failed to generate speech audio" }
    }
    return {
      success: true,
      audioData: cached.audioData,
      mimeType: cached.mimeType,
    }
  }

  private async generateUncached(
    provider: TTSProvider,
    text: string,
    runtimeOptions: Record<string, unknown>,
    apiKey: string
  ): Promise<TTSResponse> {
    const info = TTS_PROVIDERS[provider]
    if (info.requiresApiKey && !apiKey) {
      return {
        success: false,
        error: `Configure an API key for ${info.name} in Settings → Speech.`,
      }
    }
    return this.directGenerate(provider, text, runtimeOptions, apiKey)
  }

  private async directGenerate(
    provider: TTSProvider,
    text: string,
    options: Record<string, unknown>,
    apiKey: string
  ): Promise<TTSResponse> {
    try {
      switch (provider) {
        case "openai":
          return generateOpenAITTS(text, {
            ...(options as object),
            apiKey,
          } as Parameters<typeof generateOpenAITTS>[1])
        case "gemini":
          return generateGeminiTTS(text, {
            ...(options as object),
            apiKey,
          } as Parameters<typeof generateGeminiTTS>[1])
        case "edge":
          return generateEdgeTTS(text, options as Parameters<typeof generateEdgeTTS>[1])
        case "elevenlabs":
          return generateElevenLabsTTS(text, {
            ...(options as object),
            apiKey,
          } as Parameters<typeof generateElevenLabsTTS>[1])
        case "lmnt":
          return generateLMNTTTS(text, {
            ...(options as object),
            apiKey,
          } as Parameters<typeof generateLMNTTTS>[1])
        case "hume":
          return generateHumeTTS(text, {
            ...(options as object),
            apiKey,
          } as Parameters<typeof generateHumeTTS>[1])
        case "cartesia":
          return generateCartesiaTTS(text, {
            ...(options as object),
            apiKey,
          } as Parameters<typeof generateCartesiaTTS>[1])
        case "deepgram":
          return generateDeepgramTTS(text, {
            ...(options as object),
            apiKey,
          } as Parameters<typeof generateDeepgramTTS>[1])
        default:
          return { success: false, error: `Provider ${provider} not supported` }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Direct generation failed",
      }
    }
  }

  private playAudioResponse(
    response: TTSResponse,
    requestId: string,
    volume: number,
    onProgress: (progress: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!response.success || !response.audioData) {
        reject(new Error(response.error || "Audio generation failed"))
        return
      }
      const blob =
        response.audioData instanceof Blob
          ? response.audioData
          : new Blob([response.audioData], {
              type: response.mimeType || "audio/mpeg",
            })
      this.audioUrlRef = URL.createObjectURL(blob)
      this.audioRef = new Audio(this.audioUrlRef)

      this.audioRef.onplay = () => {
        if (!this.isCurrentRequest(requestId)) return
        this.setState({
          playbackState: "playing",
          isLoading: false,
          isPlaying: true,
          isPaused: false,
        })
      }
      this.audioRef.onended = () => {
        this.cleanupAudio()
        resolve()
      }
      this.audioRef.onerror = () => {
        this.cleanupAudio()
        reject(new Error("Audio playback error"))
      }
      this.audioRef.onpause = () => {
        if (
          this.audioRef &&
          this.audioRef.currentTime < this.audioRef.duration &&
          this.isCurrentRequest(requestId)
        ) {
          this.setState({
            playbackState: "paused",
            isPlaying: false,
            isPaused: true,
          })
        }
      }
      this.audioRef.ontimeupdate = () => {
        if (!this.audioRef || !this.audioRef.duration || !this.isCurrentRequest(requestId)) return
        onProgress(this.audioRef.currentTime / this.audioRef.duration)
      }
      this.audioRef.volume = Math.max(0, Math.min(1, volume))
      this.audioRef.play().catch((error) => reject(error))
    })
  }

  private playSystemChunk(
    text: string,
    speechSettings: SpeechSettings,
    requestId: string,
    onProgress: (progress: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        reject(new Error("System TTS is not supported"))
        return
      }
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      if (speechSettings.systemVoice) {
        const voice = window.speechSynthesis
          .getVoices()
          .find(
            (v) =>
              v.name === speechSettings.systemVoice || v.voiceURI === speechSettings.systemVoice
          )
        if (voice) utterance.voice = voice
      }
      utterance.rate = speechSettings.ttsRate
      utterance.pitch = speechSettings.ttsPitch
      utterance.volume = speechSettings.ttsVolume
      utterance.lang = speechSettings.sttLanguage

      utterance.onstart = () => {
        if (!this.isCurrentRequest(requestId)) return
        this.setState({
          playbackState: "playing",
          isLoading: false,
          isPlaying: true,
          isPaused: false,
        })
      }
      utterance.onboundary = () => {
        if (!this.isCurrentRequest(requestId)) return
        onProgress(Math.min(0.98, this.state.progress + 0.01))
      }
      utterance.onend = () => {
        onProgress(1)
        resolve()
      }
      utterance.onerror = (event) => {
        if (event.error === "canceled" || event.error === "interrupted") {
          resolve()
          return
        }
        reject(new Error(`Speech synthesis error: ${event.error}`))
      }
      window.speechSynthesis.speak(utterance)
    })
  }

  private getApiKey(provider: TTSProvider, providerSettings: ProviderSettingsMap): string {
    const info = TTS_PROVIDERS[provider]
    if (!info.requiresApiKey) return ""
    const keyProvider = info.apiKeyProvider ?? provider
    return providerSettings?.[keyProvider]?.apiKey ?? ""
  }

  private cleanupAudio(): void {
    if (this.audioRef) {
      this.audioRef.pause()
      this.audioRef = null
    }
    if (this.audioUrlRef) {
      URL.revokeObjectURL(this.audioUrlRef)
      this.audioUrlRef = null
    }
  }

  private updateProgress(progress: number, onProgress?: (progress: number) => void): void {
    const normalized = Math.max(0, Math.min(1, progress))
    this.setState({ progress: normalized })
    onProgress?.(normalized)
  }

  private setState(partialState: Partial<TTSOrchestratorState>): void {
    this.state = { ...this.state, ...partialState }
    for (const sub of this.subscribers) sub(this.state)
  }

  private isCurrentRequest(id: string): boolean {
    return this.activeRequestId === id
  }

  private createRequestId(): string {
    return `tts_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }
}

export const ttsOrchestrator = new TTSOrchestrator()
