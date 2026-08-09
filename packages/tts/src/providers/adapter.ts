/**
 * TTS provider adapter contract.
 *
 * Before the registry, every new provider had to be wired into four parallel
 * places: the `directGenerate` switch (orchestrator), `getProviderRuntimeOptions`
 * (speech-settings), the per-provider spread in `generateCacheKey` (tts-cache),
 * and the `TTS_PROVIDERS` metadata (types). This adapter collapses the first
 * three into a single object per provider; metadata stays in `TTS_PROVIDERS`
 * (referenced via `info`) so the UI catalog is untouched and `types` keeps no
 * dependency on `lib`.
 */

import type { SpeechSettings, TTSProviderInfo, TTSResponse, TTSSettings } from "../types"

/**
 * Playback shape of a provider:
 * - `system`  → driven directly via the Web Speech API (no `generate`).
 * - `http`    → returns a finished audio buffer (cloud REST / Tauri bridge).
 * - `streaming` → emits audio incrementally; played through a live PCM player
 *   instead of the chunk pipeline (see `generateStream`).
 */
export type TTSProviderKind = "system" | "http" | "streaming"

/** A single audio delta forwarded from a streaming provider transport. */
export interface TTSStreamEvent {
  kind: "audio" | "done" | "error"
  /** base64 PCM16 mono bytes when `kind === "audio"`. */
  audioBase64?: string
  message?: string
}

/** Options handed to a streaming provider's `generateStream`. */
export interface TTSStreamOptions {
  text: string
  apiKey: string
  runtime: Record<string, unknown>
  /** Stable id so the provider/transport can be cancelled. */
  requestId: string
  onEvent: (event: TTSStreamEvent) => void
  /** Aborts the in-flight synthesis (orchestrator triggers on stop). */
  signal: AbortSignal
}

export interface TTSBufferedGenerateOptions extends Record<string, unknown> {
  apiKey: string
  /** Aborts browser/native transport, retries, and prefetched synthesis. */
  signal?: AbortSignal
  /** Stable identity forwarded to cancellable native proxy calls. */
  requestId?: string
}

export interface TTSProviderAdapter {
  /** Metadata catalog entry (single source of truth in `TTS_PROVIDERS`). */
  info: TTSProviderInfo
  kind: TTSProviderKind
  /** Provider-specific runtime options, e.g. voice/model/speed. */
  runtimeOptions: (s: SpeechSettings) => Record<string, unknown>
  /** Fields folded into the cache key so distinct voices/models don't collide. */
  cacheKeyFields: (s: Partial<TTSSettings>) => Record<string, unknown>
  /** Synthesize a finished audio buffer. Present for `http` providers. */
  generate?: (text: string, options: TTSBufferedGenerateOptions) => Promise<TTSResponse>
  /** Start an incremental synthesis. Present for `streaming` providers. */
  generateStream?: (options: TTSStreamOptions) => Promise<void>
}
