/**
 * Adapter between the host's flat settings row and the SpeechSettings shape
 * the orchestrator/providers expect.
 *
 * cognia-next stores TTS fields directly on AppSettings (flat row in
 * IndexedDB) with the same names as TTSSettings, so this is mostly a "fill
 * defaults for unset keys" helper plus a small map for the
 * SpeechSettings.sttLanguage cross-cut. The parameter is a *structural* view
 * (`SpeechSettingsSource`) rather than the app's AppSettings type, so the
 * package stays decoupled from the app's settings hub (ADR-0068 E3): any
 * object carrying the flat TTS fields — AppSettings included — is accepted.
 */

import { getAdapter } from "./providers/registry"
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
  type MistralTTSModel,
  type MistralTTSResponseFormat,
  type OpenAITTSModel,
  type OpenAITTSVoice,
  type RealtimeTTSModel,
  type RealtimeTTSVoice,
  type SpeechSettings,
  type TTSProvider,
  type TTSSettings,
  type XiaomiTTSModel,
  type XiaomiTTSVoice,
  type XiaomiTTSStyle,
} from "./types"

/**
 * Loosen each SpeechSettings field to its primitive base so the host's wider
 * row types (plain `string` where SpeechSettings has a literal union, plus
 * `null` for unset DB columns) are accepted; the selector below narrows with
 * the same casts/defaults it always used.
 */
type LooseField<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T

export type SpeechSettingsSource = {
  [K in keyof SpeechSettings]?: LooseField<SpeechSettings[K]> | null
}

export function selectSpeechSettings(
  settings: SpeechSettingsSource | null | undefined
): SpeechSettings {
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
    geminiModel:
      (settings.geminiModel as SpeechSettings["geminiModel"] | undefined) ??
      DEFAULT_SPEECH_SETTINGS.geminiModel,

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

    mistralVoiceId: settings.mistralVoiceId ?? DEFAULT_SPEECH_SETTINGS.mistralVoiceId,
    mistralModel:
      (settings.mistralModel as MistralTTSModel | undefined) ??
      DEFAULT_SPEECH_SETTINGS.mistralModel,
    mistralResponseFormat:
      (settings.mistralResponseFormat as MistralTTSResponseFormat | undefined) ??
      DEFAULT_SPEECH_SETTINGS.mistralResponseFormat,

    realtimeVoice:
      (settings.realtimeVoice as RealtimeTTSVoice | undefined) ??
      DEFAULT_SPEECH_SETTINGS.realtimeVoice,
    realtimeModel:
      (settings.realtimeModel as RealtimeTTSModel | undefined) ??
      DEFAULT_SPEECH_SETTINGS.realtimeModel,
    realtimeInstructions:
      settings.realtimeInstructions ?? DEFAULT_SPEECH_SETTINGS.realtimeInstructions,

    ttsEnabled: settings.ttsEnabled ?? DEFAULT_SPEECH_SETTINGS.ttsEnabled,
    ttsRate: settings.ttsRate ?? DEFAULT_SPEECH_SETTINGS.ttsRate,
    ttsPitch: settings.ttsPitch ?? DEFAULT_SPEECH_SETTINGS.ttsPitch,
    ttsVolume: settings.ttsVolume ?? DEFAULT_SPEECH_SETTINGS.ttsVolume,
    ttsAutoPlay: settings.ttsAutoPlay ?? DEFAULT_SPEECH_SETTINGS.ttsAutoPlay,
    ttsCacheEnabled: settings.ttsCacheEnabled ?? DEFAULT_SPEECH_SETTINGS.ttsCacheEnabled,
    ttsStreamingEnabled:
      settings.ttsStreamingEnabled ?? DEFAULT_SPEECH_SETTINGS.ttsStreamingEnabled,
    ttsFallbackEnabled: settings.ttsFallbackEnabled ?? DEFAULT_SPEECH_SETTINGS.ttsFallbackEnabled,

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
  // Guard unknown ids — the legacy switch had a `default: {}` branch.
  return getAdapter(provider)?.runtimeOptions(s) ?? {}
}
