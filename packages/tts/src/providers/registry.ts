/**
 * TTS provider registry — the single place that knows how to drive each
 * provider. Collapses the former `directGenerate` switch (orchestrator),
 * `getProviderRuntimeOptions` switch (speech-settings) and the per-provider
 * spread in `generateCacheKey` (tts-cache) into one adapter object per
 * provider. Adding a provider now means: write its `generateXxxTTS` and add
 * one entry here (plus its `TTS_PROVIDERS` metadata).
 */

import { TTS_PROVIDERS, type TTSProvider } from "../types"

import { generateOpenAITTS } from "./openai"
import { generateLocalOpenAICompatibleTTS } from "./local-openai-compatible"
import { generateGeminiTTS } from "./gemini"
import { generateEdgeTTS } from "./edge"
import { generateElevenLabsTTS } from "./elevenlabs"
import { generateLMNTTTS } from "./lmnt"
import { generateHumeTTS } from "./hume"
import { generateCartesiaTTS } from "./cartesia"
import { generateDeepgramTTS } from "./deepgram"
import { generateXiaomiTTS } from "./xiaomi"
import { generateMistralTTS } from "./mistral"
import { synthesizeRealtimeStream } from "./openai-realtime"
import type { TTSProviderAdapter } from "./adapter"

export const TTS_ADAPTERS: Record<TTSProvider, TTSProviderAdapter> = {
  system: {
    info: TTS_PROVIDERS.system,
    kind: "system",
    runtimeOptions: (s) => ({
      voice: s.systemVoice,
      rate: s.ttsRate,
      pitch: s.ttsPitch,
      volume: s.ttsVolume,
      lang: s.sttLanguage,
    }),
    cacheKeyFields: () => ({}),
  },
  openai: {
    info: TTS_PROVIDERS.openai,
    kind: "http",
    runtimeOptions: (s) => ({
      voice: s.openaiVoice,
      model: s.openaiModel,
      speed: s.openaiSpeed,
      instructions: s.openaiInstructions,
      responseFormat: s.openaiResponseFormat,
    }),
    cacheKeyFields: (s) => ({
      voice: s.openaiVoice,
      model: s.openaiModel,
      speed: s.openaiSpeed,
      instructions: s.openaiInstructions,
      responseFormat: s.openaiResponseFormat,
    }),
    generate: (text, options) =>
      generateOpenAITTS(text, options as Parameters<typeof generateOpenAITTS>[1]),
  },
  "local-openai-compatible": {
    info: TTS_PROVIDERS["local-openai-compatible"],
    kind: "http",
    runtimeOptions: (s) => ({
      baseUrl: s.localOpenaiBaseUrl,
      model: s.localOpenaiModel,
      voice: s.localOpenaiVoice,
      speed: s.localOpenaiSpeed,
      responseFormat: s.localOpenaiResponseFormat,
      timeoutMs: s.localOpenaiTimeoutMs,
    }),
    cacheKeyFields: (s) => ({
      baseUrl: s.localOpenaiBaseUrl?.trim().replace(/\/+$/, ""),
      model: s.localOpenaiModel,
      voice: s.localOpenaiVoice,
      speed: s.localOpenaiSpeed,
      responseFormat: s.localOpenaiResponseFormat,
    }),
    generate: (text, options) =>
      generateLocalOpenAICompatibleTTS(
        text,
        options as unknown as Parameters<typeof generateLocalOpenAICompatibleTTS>[1]
      ),
  },
  gemini: {
    info: TTS_PROVIDERS.gemini,
    kind: "http",
    runtimeOptions: (s) => ({ voice: s.geminiVoice, model: s.geminiModel }),
    cacheKeyFields: (s) => ({ voice: s.geminiVoice, model: s.geminiModel }),
    generate: (text, options) =>
      generateGeminiTTS(text, options as Parameters<typeof generateGeminiTTS>[1]),
  },
  edge: {
    info: TTS_PROVIDERS.edge,
    kind: "http",
    runtimeOptions: (s) => ({
      voice: s.edgeVoice,
      rate: s.edgeRate,
      pitch: s.edgePitch,
      customSSMLEnabled: s.ttsCustomSSMLEnabled,
      customSSML: s.ttsCustomSSML,
    }),
    cacheKeyFields: (s) => ({
      voice: s.edgeVoice,
      rate: s.edgeRate,
      pitch: s.edgePitch,
      customSSML: s.ttsCustomSSMLEnabled ? s.ttsCustomSSML : undefined,
    }),
    // Edge ignores apiKey (free service via the Tauri WS bridge).
    generate: (text, options) =>
      generateEdgeTTS(text, options as Parameters<typeof generateEdgeTTS>[1]),
  },
  elevenlabs: {
    info: TTS_PROVIDERS.elevenlabs,
    kind: "http",
    runtimeOptions: (s) => ({
      voice: s.elevenlabsVoice,
      model: s.elevenlabsModel,
      stability: s.elevenlabsStability,
      similarityBoost: s.elevenlabsSimilarityBoost,
    }),
    cacheKeyFields: (s) => ({
      voice: s.elevenlabsVoice,
      model: s.elevenlabsModel,
      stability: s.elevenlabsStability,
      similarityBoost: s.elevenlabsSimilarityBoost,
    }),
    generate: (text, options) =>
      generateElevenLabsTTS(text, options as Parameters<typeof generateElevenLabsTTS>[1]),
  },
  lmnt: {
    info: TTS_PROVIDERS.lmnt,
    kind: "http",
    runtimeOptions: (s) => ({ voice: s.lmntVoice, speed: s.lmntSpeed }),
    cacheKeyFields: (s) => ({ voice: s.lmntVoice, speed: s.lmntSpeed }),
    generate: (text, options) =>
      generateLMNTTTS(text, options as Parameters<typeof generateLMNTTTS>[1]),
  },
  hume: {
    info: TTS_PROVIDERS.hume,
    kind: "http",
    runtimeOptions: (s) => ({ voice: s.humeVoice }),
    cacheKeyFields: (s) => ({ voice: s.humeVoice }),
    generate: (text, options) =>
      generateHumeTTS(text, options as Parameters<typeof generateHumeTTS>[1]),
  },
  cartesia: {
    info: TTS_PROVIDERS.cartesia,
    kind: "http",
    runtimeOptions: (s) => ({
      voice: s.cartesiaVoice,
      model: s.cartesiaModel,
      language: s.cartesiaLanguage,
      speed: s.cartesiaSpeed,
      emotion: s.cartesiaEmotion,
    }),
    cacheKeyFields: (s) => ({
      voice: s.cartesiaVoice,
      model: s.cartesiaModel,
      language: s.cartesiaLanguage,
      speed: s.cartesiaSpeed,
      emotion: s.cartesiaEmotion,
    }),
    generate: (text, options) =>
      generateCartesiaTTS(text, options as Parameters<typeof generateCartesiaTTS>[1]),
  },
  deepgram: {
    info: TTS_PROVIDERS.deepgram,
    kind: "http",
    runtimeOptions: (s) => ({ voice: s.deepgramVoice }),
    cacheKeyFields: (s) => ({ voice: s.deepgramVoice }),
    generate: (text, options) =>
      generateDeepgramTTS(text, options as Parameters<typeof generateDeepgramTTS>[1]),
  },
  xiaomi: {
    info: TTS_PROVIDERS.xiaomi,
    kind: "http",
    runtimeOptions: (s) => ({
      voice: s.xiaomiVoice,
      model: s.xiaomiModel,
      style: s.xiaomiStyle,
      dialect: s.xiaomiDialect,
    }),
    cacheKeyFields: (s) => ({
      voice: s.xiaomiVoice,
      model: s.xiaomiModel,
      style: s.xiaomiStyle,
      dialect: s.xiaomiDialect,
    }),
    generate: (text, options) =>
      generateXiaomiTTS(text, options as Parameters<typeof generateXiaomiTTS>[1]),
  },
  mistral: {
    info: TTS_PROVIDERS.mistral,
    kind: "http",
    runtimeOptions: (s) => ({
      voiceId: s.mistralVoiceId,
      model: s.mistralModel,
      responseFormat: s.mistralResponseFormat,
    }),
    cacheKeyFields: (s) => ({
      voiceId: s.mistralVoiceId,
      model: s.mistralModel,
      responseFormat: s.mistralResponseFormat,
    }),
    generate: (text, options) =>
      generateMistralTTS(text, options as Parameters<typeof generateMistralTTS>[1]),
  },
  // Retired as a selectable TTS provider (RETIRED_TTS_PROVIDERS, plan D2): a
  // pure-TTS use of the speech-to-speech Realtime model costs ~$64/1M vs ~$12
  // for `gpt-4o-mini-tts` (which the `openai` provider already uses over REST).
  // The adapter stays so persisted selections keep resolving, and the s2s
  // transport is reserved for a future real-time voice-conversation feature (O1).
  "openai-realtime": {
    info: TTS_PROVIDERS["openai-realtime"],
    kind: "streaming",
    runtimeOptions: (s) => ({
      voice: s.realtimeVoice,
      model: s.realtimeModel,
      instructions: s.realtimeInstructions,
    }),
    // Streaming providers synthesize live and bypass the chunk cache, so cache
    // fields are unused; kept for interface parity.
    cacheKeyFields: () => ({}),
    generateStream: synthesizeRealtimeStream,
  },
}

export function getAdapter(provider: TTSProvider): TTSProviderAdapter {
  return TTS_ADAPTERS[provider]
}
