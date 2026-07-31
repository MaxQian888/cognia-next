/**
 * Speech-language catalogue used by the composer's voice-input controls.
 *
 * Codes are BCP-47 tags compatible with the Web Speech API's
 * `SpeechRecognition.lang` field. `flag` is purely decorative.
 */

export interface SpeechLanguage {
  code: SpeechLanguageCode
  name: string
  flag: string
}

export const SPEECH_LANGUAGES = [
  { code: "en-US", name: "English (US)", flag: "🇺🇸" },
  { code: "en-GB", name: "English (UK)", flag: "🇬🇧" },
  { code: "zh-CN", name: "中文（简体）", flag: "🇨🇳" },
  { code: "zh-TW", name: "中文（繁體）", flag: "🇹🇼" },
  { code: "ja-JP", name: "日本語", flag: "🇯🇵" },
  { code: "ko-KR", name: "한국어", flag: "🇰🇷" },
  { code: "es-ES", name: "Español", flag: "🇪🇸" },
  { code: "fr-FR", name: "Français", flag: "🇫🇷" },
  { code: "de-DE", name: "Deutsch", flag: "🇩🇪" },
  { code: "it-IT", name: "Italiano", flag: "🇮🇹" },
  { code: "pt-BR", name: "Português (BR)", flag: "🇧🇷" },
  { code: "ru-RU", name: "Русский", flag: "🇷🇺" },
  { code: "ar-SA", name: "العربية", flag: "🇸🇦" },
] as const satisfies ReadonlyArray<{ code: string; name: string; flag: string }>

export type SpeechLanguageCode = (typeof SPEECH_LANGUAGES)[number]["code"]

export const DEFAULT_SPEECH_LANGUAGE: SpeechLanguageCode = "en-US"

export function getSpeechLanguage(code: SpeechLanguageCode): SpeechLanguage {
  return SPEECH_LANGUAGES.find((l) => l.code === code) ?? SPEECH_LANGUAGES[0]
}
