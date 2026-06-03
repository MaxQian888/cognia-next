/**
 * Adapter between AppSettings (flat row in IndexedDB) and the
 * SpeechSettings shape the orchestrator/providers expect.
 *
 * cognia-next stores TTS fields directly on AppSettings with the same
 * names as TTSSettings, so this is mostly a "fill defaults for unset
 * keys" helper plus a small map for the SpeechSettings.sttLanguage
 * cross-cut. Mirrors the role of Cognia's `speech-settings-adapter.ts`.
 */

import type { AppSettings } from "@/lib/claude/types"
import {
  DEFAULT_SPEECH_SETTINGS,
  type CartesiaTTSModel,
  type CartesiaTTSVoice,
  type DeepgramTTSVoice,
  type EdgeTTSVoice,
  type ElevenLabsTTSModel,
  type ElevenLabsTTSVoice,
  type GeminiTTSVoice,
  type HumeTTSVoice,
  type LMNTTTSVoice,
  type OpenAITTSModel,
  type OpenAITTSVoice,
  type SpeechSettings,
  type TTSProvider,
  type TTSSettings,
  type XiaomiTTSModel,
  type XiaomiTTSVoice,
  type XiaomiTTSStyle,
} from "@/types/media/tts"

export function selectSpeechSettings(settings: AppSettings | null | undefined): SpeechSettings {
  if (!settings) return DEFAULT_SPEECH_SETTINGS
  return {
    ...DEFAULT_SPEECH_SETTINGS,
    ttsProvider:
      (settings.ttsProvider as TTSProvider | undefined) ?? DEFAULT_SPEECH_SETTINGS.ttsProvider,
    systemVoice: settings.systemVoice ?? DEFAULT_SPEECH_SETTINGS.systemVoice,

    openaiVoice:
      (settings.openaiVoice as OpenAITTSVoice | undefined) ?? DEFAULT_SPEECH_SETTINGS.openaiVoice,
    openaiModel:
      (settings.openaiModel as OpenAITTSModel | undefined) ?? DEFAULT_SPEECH_SETTINGS.openaiModel,
    openaiSpeed: settings.openaiSpeed ?? DEFAULT_SPEECH_SETTINGS.openaiSpeed,
    openaiInstructions: settings.openaiInstructions ?? DEFAULT_SPEECH_SETTINGS.openaiInstructions,
    openaiResponseFormat:
      (settings.openaiResponseFormat as TTSSettings["openaiResponseFormat"] | undefined) ??
      DEFAULT_SPEECH_SETTINGS.openaiResponseFormat,

    geminiVoice:
      (settings.geminiVoice as GeminiTTSVoice | undefined) ?? DEFAULT_SPEECH_SETTINGS.geminiVoice,

    edgeVoice:
      (settings.edgeVoice as EdgeTTSVoice | undefined) ?? DEFAULT_SPEECH_SETTINGS.edgeVoice,
    edgeRate: settings.edgeRate ?? DEFAULT_SPEECH_SETTINGS.edgeRate,
    edgePitch: settings.edgePitch ?? DEFAULT_SPEECH_SETTINGS.edgePitch,

    elevenlabsVoice:
      (settings.elevenlabsVoice as ElevenLabsTTSVoice | undefined) ??
      DEFAULT_SPEECH_SETTINGS.elevenlabsVoice,
    elevenlabsModel:
      (settings.elevenlabsModel as ElevenLabsTTSModel | undefined) ??
      DEFAULT_SPEECH_SETTINGS.elevenlabsModel,
    elevenlabsStability:
      settings.elevenlabsStability ?? DEFAULT_SPEECH_SETTINGS.elevenlabsStability,
    elevenlabsSimilarityBoost:
      settings.elevenlabsSimilarityBoost ?? DEFAULT_SPEECH_SETTINGS.elevenlabsSimilarityBoost,

    lmntVoice:
      (settings.lmntVoice as LMNTTTSVoice | undefined) ?? DEFAULT_SPEECH_SETTINGS.lmntVoice,
    lmntSpeed: settings.lmntSpeed ?? DEFAULT_SPEECH_SETTINGS.lmntSpeed,

    humeVoice:
      (settings.humeVoice as HumeTTSVoice | undefined) ?? DEFAULT_SPEECH_SETTINGS.humeVoice,

    cartesiaVoice:
      (settings.cartesiaVoice as CartesiaTTSVoice | undefined) ??
      DEFAULT_SPEECH_SETTINGS.cartesiaVoice,
    cartesiaModel:
      (settings.cartesiaModel as CartesiaTTSModel | undefined) ??
      DEFAULT_SPEECH_SETTINGS.cartesiaModel,
    cartesiaLanguage: settings.cartesiaLanguage ?? DEFAULT_SPEECH_SETTINGS.cartesiaLanguage,
    cartesiaSpeed: settings.cartesiaSpeed ?? DEFAULT_SPEECH_SETTINGS.cartesiaSpeed,
    cartesiaEmotion: settings.cartesiaEmotion ?? DEFAULT_SPEECH_SETTINGS.cartesiaEmotion,

    deepgramVoice:
      (settings.deepgramVoice as DeepgramTTSVoice | undefined) ??
      DEFAULT_SPEECH_SETTINGS.deepgramVoice,

    xiaomiVoice:
      (settings.xiaomiVoice as XiaomiTTSVoice | undefined) ?? DEFAULT_SPEECH_SETTINGS.xiaomiVoice,
    xiaomiModel:
      (settings.xiaomiModel as XiaomiTTSModel | undefined) ?? DEFAULT_SPEECH_SETTINGS.xiaomiModel,
    xiaomiStyle:
      (settings.xiaomiStyle as XiaomiTTSStyle | undefined) ?? DEFAULT_SPEECH_SETTINGS.xiaomiStyle,
    xiaomiDialect: settings.xiaomiDialect ?? DEFAULT_SPEECH_SETTINGS.xiaomiDialect,

    ttsEnabled: settings.ttsEnabled ?? DEFAULT_SPEECH_SETTINGS.ttsEnabled,
    ttsRate: settings.ttsRate ?? DEFAULT_SPEECH_SETTINGS.ttsRate,
    ttsPitch: settings.ttsPitch ?? DEFAULT_SPEECH_SETTINGS.ttsPitch,
    ttsVolume: settings.ttsVolume ?? DEFAULT_SPEECH_SETTINGS.ttsVolume,
    ttsAutoPlay: settings.ttsAutoPlay ?? DEFAULT_SPEECH_SETTINGS.ttsAutoPlay,
    ttsCacheEnabled: settings.ttsCacheEnabled ?? DEFAULT_SPEECH_SETTINGS.ttsCacheEnabled,
    ttsStreamingEnabled:
      settings.ttsStreamingEnabled ?? DEFAULT_SPEECH_SETTINGS.ttsStreamingEnabled,

    ttsCustomSSMLEnabled:
      settings.ttsCustomSSMLEnabled ?? DEFAULT_SPEECH_SETTINGS.ttsCustomSSMLEnabled,
    ttsCustomSSML: settings.ttsCustomSSML ?? DEFAULT_SPEECH_SETTINGS.ttsCustomSSML,
    ttsPronunciationDictionary:
      settings.ttsPronunciationDictionary ?? DEFAULT_SPEECH_SETTINGS.ttsPronunciationDictionary,

    sttLanguage: settings.sttLanguage ?? DEFAULT_SPEECH_SETTINGS.sttLanguage,
  }
}

export function toTTSSettings(s: SpeechSettings): TTSSettings {
  // SpeechSettings already extends TTSSettings; just strip sttLanguage.
  const tts = { ...s } as Partial<SpeechSettings>
  delete tts.sttLanguage
  return tts as TTSSettings
}

export function getProviderRuntimeOptions(
  s: SpeechSettings,
  provider: TTSProvider
): Record<string, unknown> {
  switch (provider) {
    case "system":
      return {
        voice: s.systemVoice,
        rate: s.ttsRate,
        pitch: s.ttsPitch,
        volume: s.ttsVolume,
        lang: s.sttLanguage,
      }
    case "openai":
      return {
        voice: s.openaiVoice,
        model: s.openaiModel,
        speed: s.openaiSpeed,
        instructions: s.openaiInstructions,
        responseFormat: s.openaiResponseFormat,
      }
    case "gemini":
      return { voice: s.geminiVoice }
    case "edge":
      return {
        voice: s.edgeVoice,
        rate: s.edgeRate,
        pitch: s.edgePitch,
        customSSMLEnabled: s.ttsCustomSSMLEnabled,
        customSSML: s.ttsCustomSSML,
      }
    case "elevenlabs":
      return {
        voice: s.elevenlabsVoice,
        model: s.elevenlabsModel,
        stability: s.elevenlabsStability,
        similarityBoost: s.elevenlabsSimilarityBoost,
      }
    case "lmnt":
      return { voice: s.lmntVoice, speed: s.lmntSpeed }
    case "hume":
      return { voice: s.humeVoice }
    case "cartesia":
      return {
        voice: s.cartesiaVoice,
        model: s.cartesiaModel,
        language: s.cartesiaLanguage,
        speed: s.cartesiaSpeed,
        emotion: s.cartesiaEmotion,
      }
    case "deepgram":
      return { voice: s.deepgramVoice }
    case "xiaomi":
      return {
        voice: s.xiaomiVoice,
        model: s.xiaomiModel,
        style: s.xiaomiStyle,
        dialect: s.xiaomiDialect,
      }
    default:
      return {}
  }
}
