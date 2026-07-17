/**
 * TTS orchestrator — singleton wrapper around all 11 providers.
 *
 * Ported from `D:\Project\Cognia\lib\ai\tts\tts-orchestrator.ts`. The
 * cognia-next port drops the `/api/tts/<x>` route fallback (no server
 * under static export) and routes Edge-TTS through the Tauri WS bridge.
 * Direct provider calls (with a user-supplied API key) and the
 * caching/chunking/cancellation pipeline are preserved 1:1.
 */

import { getTtsHost } from "./host"

import { runChunkPipeline } from "./chunk-pipeline"
import { withTtsRetry } from "./retry"
import { PcmPlayer } from "./streaming/pcm-player"
import type { TTSStreamEvent } from "./providers/adapter"
import { generateCacheKey, getCachedOrGenerate } from "./tts-cache"
import { getProviderRuntimeOptions, toTTSSettings } from "./speech-settings"
import {
  applyPronunciationDictionary,
  detectLanguage,
  preprocessTextForProvider,
  splitTextForTTS,
} from "./tts-text-utils"
import {
  DEFAULT_SPEECH_SETTINGS,
  TTS_PROVIDERS,
  type ProviderSettingsMap,
  type SpeechSettings,
  type TTSPlaybackState,
  type TTSProvider,
  type TTSResponse,
} from "./types"

import { getAdapter } from "./providers/registry"

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
  /**
   * Opaque caller-supplied id for the surface that owns the active playback
   * (e.g. a chat message id). Lets consumers tell whether *they* are the
   * current speaker without reaching for the internal requestId. Set on
   * loading, cleared on stop/end/error.
   */
  activeSourceId?: string
}

export interface TTSOrchestratorSpeakOptions {
  provider?: TTSProvider
  source?: TTSActiveSource
  /** Opaque id for the calling surface (e.g. chat message id). */
  sourceId?: string
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
  /** Live PCM player for streaming providers (OpenAI Realtime). */
  private streamPlayer: PcmPlayer | null = null
  private streamAbort: AbortController | null = null

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
    const sourceId = options.sourceId

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
      activeSourceId: sourceId,
    })

    let normalizedText = preprocessTextForProvider(text, provider)
    const dict = speechSettings.ttsPronunciationDictionary
    if (dict && Object.keys(dict).length > 0) {
      normalizedText = applyPronunciationDictionary(normalizedText, dict)
    }

    // Streaming providers (OpenAI Realtime) play live PCM through a separate
    // engine — no chunking, no IndexedDB cache.
    if (getAdapter(provider).kind === "streaming") {
      await this.playStreaming({
        provider,
        text: normalizedText,
        speechSettings,
        providerSettings,
        requestId,
        options,
      })
      return
    }

    const skipSplit =
      provider === "edge" && speechSettings.ttsCustomSSMLEnabled && !!speechSettings.ttsCustomSSML
    const chunks = skipSplit ? [normalizedText] : splitTextForTTS(normalizedText, provider)

    try {
      options.onStart?.()

      const chunkProgress = (index: number) => {
        const base = index / chunks.length
        const weight = 1 / chunks.length
        return (p: number) => this.updateProgress(base + p * weight, options.onProgress)
      }

      if (provider === "system") {
        for (let index = 0; index < chunks.length; index++) {
          if (!this.isCurrentRequest(requestId)) return
          await this.playSystemChunk(chunks[index], speechSettings, requestId, chunkProgress(index))
        }
      } else {
        // Cloud providers: optionally prefetch chunk i+1 while chunk i plays so
        // the network round-trip overlaps playback (the `ttsStreamingEnabled`
        // optimization). With it off, behavior is the old sequential loop.
        let consumedCount = 0
        try {
          await runChunkPipeline<TTSResponse>({
            count: chunks.length,
            isCancelled: () => !this.isCurrentRequest(requestId),
            prefetch: speechSettings.ttsStreamingEnabled,
            produce: (index) =>
              this.generateChunkAudio({
                provider,
                chunk: chunks[index],
                speechSettings,
                providerSettings,
              }),
            consume: async (response, index) => {
              if (!response.success || !response.audioData) {
                throw new Error(response.error || "Failed to generate speech audio")
              }
              await this.playAudioResponse(
                response,
                requestId,
                speechSettings.ttsVolume,
                chunkProgress(index)
              )
              consumedCount = index + 1
            },
          })
        } catch (cloudError) {
          // Fall back to the free system voice for the remaining chunks rather
          // than failing the whole utterance. Already-played chunks are skipped.
          if (!speechSettings.ttsFallbackEnabled || !this.isCurrentRequest(requestId)) {
            throw cloudError
          }
          getTtsHost().notify?.message("TTS provider failed — falling back to the system voice.")
          for (let index = consumedCount; index < chunks.length; index++) {
            if (!this.isCurrentRequest(requestId)) return
            await this.playSystemChunk(
              chunks[index],
              speechSettings,
              requestId,
              chunkProgress(index)
            )
          }
        }
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
          activeSourceId: undefined,
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
        activeSourceId: undefined,
      })
      options.onError?.(message)
      getTtsHost().notify?.error(message)
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
    if (this.streamPlayer) {
      this.streamPlayer.stop()
      this.streamPlayer = null
    }
    if (this.streamAbort) {
      this.streamAbort.abort()
      this.streamAbort = null
    }
    this.setState({
      playbackState: "stopped",
      isLoading: false,
      isPlaying: false,
      isPaused: false,
      progress: 0,
      activeRequestId: undefined,
      activeSource: undefined,
      activeSourceId: undefined,
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
    } else if (this.streamPlayer) {
      this.streamPlayer.pause()
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
    } else if (this.streamPlayer) {
      this.streamPlayer.resume()
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

  private async playStreaming(params: {
    provider: TTSProvider
    text: string
    speechSettings: SpeechSettings
    providerSettings: ProviderSettingsMap
    requestId: string
    options: TTSOrchestratorSpeakOptions
  }): Promise<void> {
    const { provider, text, speechSettings, providerSettings, requestId, options } = params
    const adapter = getAdapter(provider)
    const info = TTS_PROVIDERS[provider]
    const apiKey = this.getApiKey(provider, providerSettings)
    const runtime = getProviderRuntimeOptions(speechSettings, provider)
    const abort = new AbortController()
    this.streamAbort = abort

    try {
      options.onStart?.()
      if (!adapter.generateStream) {
        throw new Error(`Provider ${provider} does not support streaming`)
      }
      if (info.requiresApiKey && !apiKey) {
        throw new Error(`Configure an API key for ${info.name} in Settings → Speech.`)
      }

      await new Promise<void>((resolve, reject) => {
        let started = false
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        const fail = (message: string) => {
          if (settled) return
          settled = true
          reject(new Error(message))
        }

        const player = new PcmPlayer({
          sampleRate: 24000,
          volume: speechSettings.ttsVolume,
          onProgress: (p) => {
            if (this.isCurrentRequest(requestId)) this.updateProgress(p, options.onProgress)
          },
          onEnded: finish,
        })
        this.streamPlayer = player

        // A stop() during playback aborts the transport and resolves gracefully.
        abort.signal.addEventListener("abort", finish)

        const onEvent = (event: TTSStreamEvent) => {
          if (!this.isCurrentRequest(requestId)) return
          if (event.kind === "audio" && event.audioBase64) {
            if (!started) {
              started = true
              this.setState({
                playbackState: "playing",
                isLoading: false,
                isPlaying: true,
                isPaused: false,
              })
            }
            try {
              player.enqueue(base64ToArrayBuffer(event.audioBase64))
            } catch (error) {
              fail(error instanceof Error ? error.message : "Audio playback error")
            }
          } else if (event.kind === "done") {
            player.end()
          } else if (event.kind === "error") {
            fail(event.message ?? "Realtime synthesis failed")
          }
        }

        adapter.generateStream!({ text, apiKey, runtime, requestId, onEvent, signal: abort.signal })
          .then(() => {
            // Transport closed without ever emitting audio → nothing to drain.
            if (!started) finish()
          })
          .catch((error) =>
            fail(error instanceof Error ? error.message : "Realtime synthesis failed")
          )
      })

      if (this.isCurrentRequest(requestId)) {
        this.setState({
          playbackState: "stopped",
          isLoading: false,
          isPlaying: false,
          isPaused: false,
          progress: 1,
          activeRequestId: undefined,
          activeSource: undefined,
          activeSourceId: undefined,
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
        activeSourceId: undefined,
      })
      options.onError?.(message)
      getTtsHost().notify?.error(message)
      throw error
    } finally {
      if (this.isCurrentRequest(requestId)) this.activeRequestId = null
      if (this.streamPlayer) {
        this.streamPlayer.stop()
        this.streamPlayer = null
      }
      this.streamAbort = null
    }
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

    const cacheKey = await generateCacheKey(chunk, provider, ttsSettings)
    const cached = await getCachedOrGenerate(
      cacheKey,
      async () => {
        // Retry transient network/api failures before giving up on this chunk.
        const generated = await withTtsRetry(() =>
          this.generateUncached(provider, chunk, runtimeOptions, apiKey)
        )
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
    const adapter = getAdapter(provider)
    if (!adapter.generate) {
      return { success: false, error: `Provider ${provider} not supported` }
    }
    try {
      return await adapter.generate(text, { ...options, apiKey })
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
      // Language of the *spoken* text, not `sttLanguage` (the microphone
      // recognition language). Using sttLanguage here meant a Chinese reply was
      // read by an English voice whenever STT was left on its en-US default.
      utterance.lang = detectLanguage(text)

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

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export const ttsOrchestrator = new TTSOrchestrator()
