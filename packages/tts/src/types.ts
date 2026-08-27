/**
 * TTS Types — ported verbatim from D:\Project\Cognia\types\media\tts.ts.
 * Supports system, cloud, realtime, and local OpenAI-compatible providers: OpenAI,
 * Edge, ElevenLabs, LMNT, Hume, Cartesia, Deepgram, Xiaomi, and Mistral.
 */

export type TTSProvider =
  | "system"
  | "openai"
  | "local-openai-compatible"
  | "gemini"
  | "edge"
  | "elevenlabs"
  | "lmnt"
  | "hume"
  | "cartesia"
  | "deepgram"
  | "xiaomi"
  | "mistral"
  | "openai-realtime"

/** Providers that can be selected and executed by the current TTS runtime. */
export type SelectableTTSProvider = Exclude<TTSProvider, "edge" | "openai-realtime">

/**
 * Legacy web fallback row for the `tts_provider_keys` Dexie table. New writes
 * use the encrypted Browser Vault (or the OS keyring on desktop); this shape is
 * retained so old cleartext rows can be migrated safely on read.
 */
export interface TtsProviderKeyRow {
  /** "tts.providerKey.<provider>" */
  id: string
  /** Legacy cleartext value. Never written by current code. */
  value?: string
}

export interface TTSProviderInfo {
  id: TTSProvider
  name: string
  description: string
  requiresApiKey: boolean
  /** The provider accepts a key when its deployment is protected, but does not require one. */
  supportsOptionalApiKey?: boolean
  /** Which provider's API key to use (some share, e.g., gemini → google). */
  apiKeyProvider?: string
  /** True only when audio bytes arrive incrementally from the transport. */
  supportsStreaming: boolean
  maxTextLength: number
}

export const TTS_PROVIDERS: Record<TTSProvider, TTSProviderInfo> = {
  system: {
    id: "system",
    name: "System (Browser)",
    description: "Uses your browser's built-in speech synthesis",
    requiresApiKey: false,
    supportsStreaming: true,
    maxTextLength: 32767,
  },
  openai: {
    id: "openai",
    name: "OpenAI TTS",
    description: "High-quality neural voices from OpenAI",
    requiresApiKey: true,
    apiKeyProvider: "openai",
    supportsStreaming: false,
    maxTextLength: 4096,
  },
  "local-openai-compatible": {
    id: "local-openai-compatible",
    name: "Local OpenAI-compatible",
    description: "Loopback OpenAI-compatible speech endpoint (LocalAI, Kokoro, or Piper)",
    requiresApiKey: false,
    supportsOptionalApiKey: true,
    apiKeyProvider: "local-openai-compatible",
    supportsStreaming: false,
    maxTextLength: 10000,
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini TTS",
    description: "Native expressive text-to-speech from Gemini 3.1 and 2.5",
    requiresApiKey: true,
    apiKeyProvider: "google",
    supportsStreaming: false,
    maxTextLength: 8000,
  },
  edge: {
    id: "edge",
    name: "Edge TTS",
    description: "Microsoft Edge neural voices (free)",
    requiresApiKey: false,
    supportsStreaming: false,
    maxTextLength: 10000,
  },
  elevenlabs: {
    id: "elevenlabs",
    name: "ElevenLabs",
    description: "Industry-leading AI voice synthesis",
    requiresApiKey: true,
    apiKeyProvider: "elevenlabs",
    supportsStreaming: false,
    maxTextLength: 10000,
  },
  lmnt: {
    id: "lmnt",
    name: "LMNT",
    description: "Ultra-low latency voice synthesis",
    requiresApiKey: true,
    apiKeyProvider: "lmnt",
    supportsStreaming: false,
    maxTextLength: 3000,
  },
  hume: {
    id: "hume",
    name: "Hume AI",
    description: "Emotionally expressive voice synthesis",
    requiresApiKey: true,
    apiKeyProvider: "hume",
    supportsStreaming: false,
    maxTextLength: 5000,
  },
  cartesia: {
    id: "cartesia",
    name: "Cartesia Sonic",
    description: "Ultra-low latency streaming TTS with 42 languages",
    requiresApiKey: true,
    apiKeyProvider: "cartesia",
    supportsStreaming: false,
    maxTextLength: 10000,
  },
  deepgram: {
    id: "deepgram",
    name: "Deepgram Aura",
    description: "Enterprise-grade low-latency TTS",
    requiresApiKey: true,
    apiKeyProvider: "deepgram",
    supportsStreaming: false,
    maxTextLength: 10000,
  },
  xiaomi: {
    id: "xiaomi",
    name: "Xiaomi MiMo TTS",
    description: "Xiaomi MiMo TTS with style tags and dialect support",
    requiresApiKey: true,
    apiKeyProvider: "xiaomi",
    supportsStreaming: false,
    maxTextLength: 8000,
  },
  mistral: {
    id: "mistral",
    name: "Mistral Voxtral TTS",
    description: "Multilingual speech and zero-shot voice cloning with Voxtral",
    requiresApiKey: true,
    apiKeyProvider: "mistral",
    supportsStreaming: false,
    // Mistral recommends prompts under 300 words. This conservative character
    // limit keeps chunks within that guidance for typical prose.
    maxTextLength: 3000,
  },
  "openai-realtime": {
    id: "openai-realtime",
    name: "OpenAI Realtime",
    description: "Low-latency streaming voices (desktop only)",
    requiresApiKey: true,
    apiKeyProvider: "openai",
    supportsStreaming: true,
    maxTextLength: 4096,
  },
}

export const OPENAI_TTS_VOICES = [
  { id: "alloy", name: "Alloy", description: "Neutral and balanced" },
  { id: "ash", name: "Ash", description: "Soft and conversational" },
  { id: "ballad", name: "Ballad", description: "Warm and storytelling" },
  { id: "coral", name: "Coral", description: "Clear and engaging" },
  { id: "echo", name: "Echo", description: "Warm and engaging" },
  { id: "fable", name: "Fable", description: "Expressive and dynamic" },
  { id: "onyx", name: "Onyx", description: "Deep and authoritative" },
  { id: "nova", name: "Nova", description: "Friendly and upbeat" },
  { id: "sage", name: "Sage", description: "Wise and measured" },
  { id: "shimmer", name: "Shimmer", description: "Clear and pleasant" },
  { id: "verse", name: "Verse", description: "Versatile and expressive" },
  { id: "marin", name: "Marin", description: "Natural and friendly" },
  { id: "cedar", name: "Cedar", description: "Calm and grounded" },
] as const

export type OpenAITTSVoice = (typeof OPENAI_TTS_VOICES)[number]["id"]

export const OPENAI_TTS_MODELS = [
  {
    id: "gpt-4o-mini-tts",
    name: "GPT-4o Mini TTS",
    description: "Best quality, supports instructions",
  },
  { id: "tts-1", name: "TTS-1", description: "Standard quality, faster" },
  { id: "tts-1-hd", name: "TTS-1 HD", description: "High definition audio" },
] as const

export type OpenAITTSModel = (typeof OPENAI_TTS_MODELS)[number]["id"]

export type BufferedTTSResponseFormat = "mp3" | "opus" | "aac" | "flac" | "wav"

export const GEMINI_TTS_VOICES = [
  { id: "Zephyr", name: "Zephyr", description: "Bright" },
  { id: "Puck", name: "Puck", description: "Upbeat" },
  { id: "Charon", name: "Charon", description: "Informative" },
  { id: "Kore", name: "Kore", description: "Firm" },
  { id: "Fenrir", name: "Fenrir", description: "Excitable" },
  { id: "Leda", name: "Leda", description: "Youthful" },
  { id: "Orus", name: "Orus", description: "Firm" },
  { id: "Aoede", name: "Aoede", description: "Breezy" },
  { id: "Callirrhoe", name: "Callirrhoe", description: "Easy-going" },
  { id: "Autonoe", name: "Autonoe", description: "Bright" },
  { id: "Enceladus", name: "Enceladus", description: "Breathy" },
  { id: "Iapetus", name: "Iapetus", description: "Clear" },
  { id: "Umbriel", name: "Umbriel", description: "Easy-going" },
  { id: "Algieba", name: "Algieba", description: "Smooth" },
  { id: "Despina", name: "Despina", description: "Smooth" },
  { id: "Erinome", name: "Erinome", description: "Clear" },
  { id: "Algenib", name: "Algenib", description: "Gravelly" },
  { id: "Rasalgethi", name: "Rasalgethi", description: "Informative" },
  { id: "Laomedeia", name: "Laomedeia", description: "Upbeat" },
  { id: "Achernar", name: "Achernar", description: "Soft" },
  { id: "Alnilam", name: "Alnilam", description: "Firm" },
  { id: "Schedar", name: "Schedar", description: "Even" },
  { id: "Gacrux", name: "Gacrux", description: "Mature" },
  { id: "Pulcherrima", name: "Pulcherrima", description: "Forward" },
  { id: "Achird", name: "Achird", description: "Friendly" },
  { id: "Zubenelgenubi", name: "Zubenelgenubi", description: "Casual" },
  { id: "Vindemiatrix", name: "Vindemiatrix", description: "Gentle" },
  { id: "Sadachbia", name: "Sadachbia", description: "Lively" },
  { id: "Sadaltager", name: "Sadaltager", description: "Knowledgeable" },
  { id: "Sulafat", name: "Sulafat", description: "Warm" },
] as const

export type GeminiTTSVoice = (typeof GEMINI_TTS_VOICES)[number]["id"]

export const GEMINI_TTS_MODELS = [
  {
    id: "gemini-3.1-flash-tts-preview",
    name: "Gemini 3.1 Flash TTS",
    description: "Latest low-latency expressive speech model",
  },
  {
    id: "gemini-2.5-flash-preview-tts",
    name: "Gemini 2.5 Flash TTS",
    description: "Cost-efficient controllable speech",
  },
  {
    id: "gemini-2.5-pro-preview-tts",
    name: "Gemini 2.5 Pro TTS",
    description: "High-fidelity speech for structured workflows",
  },
] as const

export type GeminiTTSModel = (typeof GEMINI_TTS_MODELS)[number]["id"]

export const EDGE_TTS_VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", name: "Xiaoxiao (女)", language: "zh-CN", gender: "Female" },
  { id: "zh-CN-YunxiNeural", name: "Yunxi (男)", language: "zh-CN", gender: "Male" },
  { id: "zh-CN-YunyangNeural", name: "Yunyang (男)", language: "zh-CN", gender: "Male" },
  { id: "zh-CN-XiaoyiNeural", name: "Xiaoyi (女)", language: "zh-CN", gender: "Female" },
  { id: "zh-TW-HsiaoChenNeural", name: "HsiaoChen (女)", language: "zh-TW", gender: "Female" },
  { id: "zh-TW-YunJheNeural", name: "YunJhe (男)", language: "zh-TW", gender: "Male" },
  { id: "en-US-JennyNeural", name: "Jenny (Female)", language: "en-US", gender: "Female" },
  { id: "en-US-GuyNeural", name: "Guy (Male)", language: "en-US", gender: "Male" },
  { id: "en-US-AriaNeural", name: "Aria (Female)", language: "en-US", gender: "Female" },
  { id: "en-US-DavisNeural", name: "Davis (Male)", language: "en-US", gender: "Male" },
  { id: "en-GB-SoniaNeural", name: "Sonia (Female)", language: "en-GB", gender: "Female" },
  { id: "en-GB-RyanNeural", name: "Ryan (Male)", language: "en-GB", gender: "Male" },
  { id: "ja-JP-NanamiNeural", name: "Nanami (Female)", language: "ja-JP", gender: "Female" },
  { id: "ja-JP-KeitaNeural", name: "Keita (Male)", language: "ja-JP", gender: "Male" },
  { id: "ko-KR-SunHiNeural", name: "SunHi (Female)", language: "ko-KR", gender: "Female" },
  { id: "ko-KR-InJoonNeural", name: "InJoon (Male)", language: "ko-KR", gender: "Male" },
  { id: "fr-FR-DeniseNeural", name: "Denise (Female)", language: "fr-FR", gender: "Female" },
  { id: "fr-FR-HenriNeural", name: "Henri (Male)", language: "fr-FR", gender: "Male" },
  { id: "de-DE-KatjaNeural", name: "Katja (Female)", language: "de-DE", gender: "Female" },
  { id: "de-DE-ConradNeural", name: "Conrad (Male)", language: "de-DE", gender: "Male" },
  { id: "es-ES-ElviraNeural", name: "Elvira (Female)", language: "es-ES", gender: "Female" },
  { id: "es-ES-AlvaroNeural", name: "Alvaro (Male)", language: "es-ES", gender: "Male" },
  { id: "it-IT-ElsaNeural", name: "Elsa (Female)", language: "it-IT", gender: "Female" },
] as const

export type EdgeTTSVoice = (typeof EDGE_TTS_VOICES)[number]["id"]

export const ELEVENLABS_TTS_VOICES = [
  { id: "rachel", name: "Rachel", description: "Calm, young female" },
  { id: "domi", name: "Domi", description: "Strong, young female" },
  { id: "bella", name: "Bella", description: "Soft, young female" },
  { id: "antoni", name: "Antoni", description: "Well-rounded, young male" },
  { id: "elli", name: "Elli", description: "Emotional, young female" },
  { id: "josh", name: "Josh", description: "Deep, young male" },
  { id: "arnold", name: "Arnold", description: "Crisp, middle-aged male" },
  { id: "adam", name: "Adam", description: "Deep, middle-aged male" },
  { id: "sam", name: "Sam", description: "Raspy, young male" },
] as const

/** ElevenLabs voice ids are account-scoped and discovered at runtime. */
export type ElevenLabsTTSVoice = string

export const ELEVENLABS_TTS_MODELS = [
  {
    id: "eleven_v3",
    name: "Eleven v3",
    description: "Most expressive, 70+ languages",
  },
  {
    id: "eleven_multilingual_v2",
    name: "Multilingual v2",
    description: "Best quality, 29 languages",
  },
  {
    id: "eleven_flash_v2_5",
    name: "Flash v2.5",
    description: "Ultra-low latency, 32 languages",
  },
  { id: "eleven_flash_v2", name: "Flash v2", description: "Ultra-low latency, English" },
  {
    id: "eleven_turbo_v2_5",
    name: "Turbo v2.5 (deprecated)",
    description: "Use Flash v2.5 for lower latency",
  },
  {
    id: "eleven_turbo_v2",
    name: "Turbo v2 (deprecated)",
    description: "Use Flash v2 for lower latency",
  },
  {
    id: "eleven_monolingual_v1",
    name: "Monolingual v1 (legacy)",
    description: "Legacy English-only model",
  },
] as const

export type ElevenLabsTTSModel = (typeof ELEVENLABS_TTS_MODELS)[number]["id"]

export const LMNT_TTS_VOICES = [
  { id: "lily", name: "Lily", description: "Friendly, conversational female" },
  { id: "daniel", name: "Daniel", description: "Professional, male" },
  { id: "mia", name: "Mia", description: "Warm, female" },
  { id: "morgan", name: "Morgan", description: "Neutral, androgynous" },
  { id: "zoe", name: "Zoe", description: "Energetic, young female" },
] as const

export type LMNTTTSVoice = (typeof LMNT_TTS_VOICES)[number]["id"]

export const HUME_TTS_VOICES = [
  { id: "ito", name: "Ito", description: "Calm, male" },
  { id: "kora", name: "Kora", description: "Warm, female" },
  { id: "dacher", name: "Dacher", description: "Friendly, male" },
  { id: "aura", name: "Aura", description: "Soothing, female" },
  { id: "finn", name: "Finn", description: "Energetic, male" },
] as const

export type HumeTTSVoice = (typeof HUME_TTS_VOICES)[number]["id"]

export const CARTESIA_TTS_VOICES = [
  {
    id: "a0e99841-438c-4a64-b679-ae501e7d6091",
    name: "Barbershop Man",
    description: "Warm male narrator",
  },
  {
    id: "79a125e8-cd45-4c13-8a67-188112f4dd22",
    name: "British Lady",
    description: "Elegant British female",
  },
  {
    id: "87748186-23bb-4571-8b7b-0e4be7e5fe10",
    name: "Calm Lady",
    description: "Soothing female",
  },
  {
    id: "41534e16-2966-4c6b-9670-111411def906",
    name: "Confident Man",
    description: "Confident male",
  },
  {
    id: "c8f42367-f4d3-4127-91fc-6a005efeb11f",
    name: "Friendly Sidekick",
    description: "Friendly conversational",
  },
  {
    id: "63ff761f-c1e8-414b-b969-d1833d1c870c",
    name: "Gentle Lady",
    description: "Soft and gentle female",
  },
  {
    id: "bf991597-6c13-47e4-8a8c-f35d0f7e2579",
    name: "Laidback Woman",
    description: "Relaxed female",
  },
  {
    id: "ee7ea9f8-c0c1-498c-9f62-dc2627e1e3ef",
    name: "Newsman",
    description: "Professional news anchor",
  },
  {
    id: "b7d50908-b89b-4ec4-b2c7-1c72b5ebb5fb",
    name: "Reading Lady",
    description: "Clear reading voice",
  },
  {
    id: "421b3369-f63f-4b03-8980-37a44df1d4e8",
    name: "Reflective Woman",
    description: "Thoughtful female",
  },
] as const

export type CartesiaTTSVoice = (typeof CARTESIA_TTS_VOICES)[number]["id"]

export const CARTESIA_TTS_MODELS = [
  { id: "sonic-3", name: "Sonic 3", description: "Latest, highest quality" },
  { id: "sonic-turbo", name: "Sonic Turbo", description: "Ultra-low latency (40ms)" },
] as const

export type CartesiaTTSModel = (typeof CARTESIA_TTS_MODELS)[number]["id"]

export const DEEPGRAM_TTS_VOICES = [
  { id: "aura-2-thalia-en", name: "Thalia", description: "Warm female", language: "en" },
  { id: "aura-2-andromeda-en", name: "Andromeda", description: "Bright female", language: "en" },
  { id: "aura-2-arcas-en", name: "Arcas", description: "Confident male", language: "en" },
  { id: "aura-2-luna-en", name: "Luna", description: "Soft female", language: "en" },
  { id: "aura-2-helios-en", name: "Helios", description: "Professional male", language: "en" },
  { id: "aura-2-athena-en", name: "Athena", description: "Clear female", language: "en" },
  { id: "aura-2-orion-en", name: "Orion", description: "Deep male", language: "en" },
  { id: "aura-2-stella-en", name: "Stella", description: "Friendly female", language: "en" },
  { id: "aura-2-zeus-en", name: "Zeus", description: "Authoritative male", language: "en" },
  { id: "aura-2-asteria-en", name: "Asteria", description: "Natural female", language: "en" },
  { id: "aura-2-celeste-es", name: "Celeste", description: "Energetic female", language: "es" },
  { id: "aura-2-estrella-es", name: "Estrella", description: "Calm female", language: "es" },
  { id: "aura-2-nestor-es", name: "Nestor", description: "Professional male", language: "es" },
  { id: "aura-2-rhea-nl", name: "Rhea", description: "Warm female", language: "nl" },
  { id: "aura-2-sander-nl", name: "Sander", description: "Deep male", language: "nl" },
  { id: "aura-2-fujin-ja", name: "Fujin", description: "Professional male", language: "ja" },
  { id: "aura-2-izanami-ja", name: "Izanami", description: "Polite female", language: "ja" },
] as const

export type DeepgramTTSVoice = (typeof DEEPGRAM_TTS_VOICES)[number]["id"]

export const XIAOMI_TTS_VOICES = [
  { id: "mimo_default", name: "MiMo Default", description: "Default multilingual voice" },
  { id: "default_zh", name: "Default Chinese", description: "Chinese female voice" },
  { id: "default_en", name: "Default English", description: "English female voice" },
] as const

export type XiaomiTTSVoice = (typeof XIAOMI_TTS_VOICES)[number]["id"]

export const XIAOMI_TTS_MODELS = [
  { id: "mimo-v2-tts", name: "MiMo V2 TTS", description: "Latest MiMo TTS model" },
] as const

export type XiaomiTTSModel = (typeof XIAOMI_TTS_MODELS)[number]["id"]

export const MISTRAL_TTS_MODELS = [
  {
    id: "voxtral-mini-tts-2603",
    name: "Voxtral TTS",
    description: "Expressive multilingual TTS with reusable cloned voices",
  },
] as const

export type MistralTTSModel = (typeof MISTRAL_TTS_MODELS)[number]["id"]
export type MistralTTSResponseFormat = Exclude<BufferedTTSResponseFormat, "aac">

export const XIAOMI_TTS_STYLES = [
  { id: "开心", name: "Happy", tag: "[开心]" },
  { id: "悲伤", name: "Sad", tag: "[悲伤]" },
  { id: "生气", name: "Angry", tag: "[生气]" },
  { id: "东北话", name: "Dongbei dialect", tag: "[东北话]" },
  { id: "四川话", name: "Sichuan dialect", tag: "[四川话]" },
  { id: "粤语", name: "Cantonese", tag: "[粤语]" },
  { id: "台湾腔", name: "Taiwanese accent", tag: "[台湾腔]" },
  { id: "变快", name: "Faster", tag: "[变快]" },
  { id: "变慢", name: "Slower", tag: "[变慢]" },
  { id: "唱歌", name: "Singing", tag: "[唱歌]" },
  { id: "孙悟空", name: "Sun Wukong", tag: "[孙悟空]" },
  { id: "林黛玉", name: "Lin Daiyu", tag: "[林黛玉]" },
] as const

export type XiaomiTTSStyle = (typeof XIAOMI_TTS_STYLES)[number]["id"]

// OpenAI Realtime — the gpt-realtime voice set (a superset of the classic TTS
// voices). Synthesis streams 24kHz PCM16 over a WebSocket through the Tauri
// bridge, so this provider is desktop-only.
export const REALTIME_TTS_VOICES = [
  { id: "alloy", name: "Alloy", description: "Neutral and balanced" },
  { id: "ash", name: "Ash", description: "Soft and conversational" },
  { id: "ballad", name: "Ballad", description: "Warm and storytelling" },
  { id: "coral", name: "Coral", description: "Clear and engaging" },
  { id: "echo", name: "Echo", description: "Warm and engaging" },
  { id: "sage", name: "Sage", description: "Wise and measured" },
  { id: "shimmer", name: "Shimmer", description: "Clear and pleasant" },
  { id: "verse", name: "Verse", description: "Versatile and expressive" },
  { id: "marin", name: "Marin", description: "Natural and friendly" },
  { id: "cedar", name: "Cedar", description: "Calm and grounded" },
] as const

export type RealtimeTTSVoice = (typeof REALTIME_TTS_VOICES)[number]["id"]

export const REALTIME_TTS_MODELS = [
  {
    id: "gpt-realtime-2.1",
    name: "GPT Realtime 2.1",
    description: "Latest full-size realtime speech model",
  },
  {
    id: "gpt-realtime-2.1-mini",
    name: "GPT Realtime 2.1 Mini",
    description: "Latest lower-cost realtime speech model",
  },
  { id: "gpt-realtime", name: "GPT Realtime (legacy)", description: "Legacy persisted model" },
  {
    id: "gpt-realtime-mini",
    name: "GPT Realtime Mini (legacy)",
    description: "Legacy persisted lower-cost model",
  },
] as const

export type RealtimeTTSModel = (typeof REALTIME_TTS_MODELS)[number]["id"]

/**
 * Full TTS settings — flattened into AppSettings on the cognia-next side.
 * Names match the sibling Cognia project so the ported orchestrator
 * code can stay 1:1.
 */
export interface TTSSettings {
  ttsProvider: TTSProvider

  systemVoice: string

  openaiVoice: OpenAITTSVoice
  openaiModel: OpenAITTSModel
  openaiSpeed: number
  openaiInstructions: string
  openaiResponseFormat: BufferedTTSResponseFormat

  localOpenaiBaseUrl: string
  localOpenaiModel: string
  localOpenaiVoice: string
  localOpenaiSpeed: number
  localOpenaiResponseFormat: BufferedTTSResponseFormat
  localOpenaiTimeoutMs: number

  geminiVoice: GeminiTTSVoice
  geminiModel: GeminiTTSModel

  edgeVoice: EdgeTTSVoice
  edgeRate: string
  edgePitch: string

  elevenlabsVoice: ElevenLabsTTSVoice
  elevenlabsModel: ElevenLabsTTSModel
  elevenlabsStability: number
  elevenlabsSimilarityBoost: number

  lmntVoice: LMNTTTSVoice
  lmntSpeed: number

  humeVoice: HumeTTSVoice

  cartesiaVoice: CartesiaTTSVoice
  cartesiaModel: CartesiaTTSModel
  cartesiaLanguage: string
  cartesiaSpeed: number
  cartesiaEmotion: string

  deepgramVoice: DeepgramTTSVoice

  xiaomiVoice: XiaomiTTSVoice
  xiaomiModel: XiaomiTTSModel
  xiaomiStyle: XiaomiTTSStyle | ""
  xiaomiDialect: string

  mistralVoiceId: string
  mistralModel: MistralTTSModel
  mistralResponseFormat: MistralTTSResponseFormat

  realtimeVoice: RealtimeTTSVoice
  realtimeModel: RealtimeTTSModel
  /** Style/delivery direction the realtime model follows while reading. */
  realtimeInstructions: string

  ttsEnabled: boolean
  ttsRate: number
  ttsPitch: number
  ttsVolume: number
  ttsAutoPlay: boolean
  ttsCacheEnabled: boolean
  ttsStreamingEnabled: boolean
  /** On a cloud-provider failure, fall back to the free system voice. */
  ttsFallbackEnabled: boolean

  ttsCustomSSMLEnabled: boolean
  ttsCustomSSML: string
  ttsPronunciationDictionary: Record<string, string>
}

export const DEFAULT_TTS_SETTINGS: TTSSettings = {
  ttsProvider: "system",

  systemVoice: "",

  openaiVoice: "alloy",
  openaiModel: "gpt-4o-mini-tts",
  openaiSpeed: 1.0,
  openaiInstructions: "",
  openaiResponseFormat: "mp3",

  localOpenaiBaseUrl: "",
  localOpenaiModel: "",
  localOpenaiVoice: "",
  localOpenaiSpeed: 1.0,
  localOpenaiResponseFormat: "mp3",
  localOpenaiTimeoutMs: 60_000,

  geminiVoice: "Kore",
  geminiModel: "gemini-3.1-flash-tts-preview",

  edgeVoice: "en-US-JennyNeural",
  edgeRate: "+0%",
  edgePitch: "+0Hz",

  elevenlabsVoice: "rachel",
  elevenlabsModel: "eleven_multilingual_v2",
  elevenlabsStability: 0.5,
  elevenlabsSimilarityBoost: 0.75,

  lmntVoice: "lily",
  lmntSpeed: 1.0,

  humeVoice: "kora",

  cartesiaVoice: "a0e99841-438c-4a64-b679-ae501e7d6091",
  cartesiaModel: "sonic-3",
  cartesiaLanguage: "en",
  cartesiaSpeed: 0,
  cartesiaEmotion: "",

  deepgramVoice: "aura-2-asteria-en",

  xiaomiVoice: "mimo_default",
  xiaomiModel: "mimo-v2-tts",
  xiaomiStyle: "",
  xiaomiDialect: "",

  mistralVoiceId: "",
  mistralModel: "voxtral-mini-tts-2603",
  mistralResponseFormat: "mp3",

  realtimeVoice: "marin",
  realtimeModel: "gpt-realtime-2.1",
  realtimeInstructions: "",

  ttsEnabled: false,
  ttsRate: 1.0,
  ttsPitch: 1.0,
  ttsVolume: 1.0,
  ttsAutoPlay: false,
  ttsCacheEnabled: true,
  ttsStreamingEnabled: true,
  ttsFallbackEnabled: true,

  ttsCustomSSMLEnabled: false,
  ttsCustomSSML: "",
  ttsPronunciationDictionary: {},
}

export interface TTSRequest {
  text: string
  provider: TTSProvider
  voice?: string
  model?: string
  speed?: number
  rate?: number
  pitch?: number
  volume?: number
}

export interface TTSResponse {
  success: boolean
  audioData?: ArrayBuffer | Blob
  audioUrl?: string
  mimeType?: string
  duration?: number
  /** Canonical, user-facing message (the collapsed `ERROR_MESSAGES[type]`). */
  error?: string
  /** Structured failure detail (W14): the error kind, the upstream HTTP status
   *  (when it came from a provider response), and the provider's own message.
   *  Preserved so the UI can show the real reason and retry can classify by
   *  status — a permanent 401 must not be retried like a transient 503. */
  errorType?: TTSErrorType
  status?: number
  providerMessage?: string
}

export interface TTSNormalizedError {
  error: string
  provider: TTSProvider | "unknown"
  status: number
  code: string
  retriable: boolean
}

export type TTSPlaybackState = "idle" | "loading" | "playing" | "paused" | "stopped" | "error"

export type TTSErrorType =
  | "not-supported"
  | "api-key-missing"
  | "api-error"
  | "network-error"
  | "text-too-long"
  | "voice-not-found"
  | "audio-playback-error"
  | "pii-blocked"
  | "cancelled"

export interface TTSError {
  type: TTSErrorType
  message: string
  details?: string
}

const ERROR_MESSAGES: Record<TTSErrorType, string> = {
  "not-supported": "Text-to-speech is not supported in this browser",
  "api-key-missing": "API key is required for this TTS provider",
  "api-error": "TTS API returned an error",
  "network-error": "Network error occurred while generating speech",
  "text-too-long": "Text exceeds maximum length for this provider",
  "voice-not-found": "Selected voice is not available",
  "audio-playback-error": "Failed to play audio",
  "pii-blocked": "Speech synthesis was blocked because the text contains sensitive data",
  cancelled: "Speech synthesis was cancelled",
}

/**
 * Build a structured failure `TTSResponse` (W14). Keeps the canonical message
 * for display AND the error kind / HTTP status / provider message, so callers
 * (retry, UI) don't have to reverse-engineer a collapsed string.
 */
export function ttsFailure(
  type: TTSErrorType,
  opts: { status?: number; providerMessage?: string } = {}
): TTSResponse {
  return {
    success: false,
    error: ERROR_MESSAGES[type],
    errorType: type,
    status: opts.status,
    providerMessage: opts.providerMessage,
  }
}

export function getTTSError(type: TTSErrorType, details?: string): TTSError {
  return { type, message: ERROR_MESSAGES[type], details }
}

export function getEdgeVoicesByLanguage(langCode: string): (typeof EDGE_TTS_VOICES)[number][] {
  const lang = langCode.split("-")[0]
  return EDGE_TTS_VOICES.filter((v) => v.language.startsWith(lang))
}

export function providerRequiresApiKey(provider: TTSProvider): boolean {
  return TTS_PROVIDERS[provider].requiresApiKey
}

export function getApiKeyProvider(provider: TTSProvider): string | undefined {
  return TTS_PROVIDERS[provider].apiKeyProvider
}

/** Selectable provider IDs that need an API key, in display order. */
export const KEYED_TTS_PROVIDERS: SelectableTTSProvider[] = [
  "openai",
  "gemini",
  "elevenlabs",
  "lmnt",
  "hume",
  "cartesia",
  "deepgram",
  "xiaomi",
  "mistral",
]

/**
 * Retired providers — kept in the `TTSProvider` union and `TTS_PROVIDERS`
 * record (so persisted selections and code keep resolving) but removed from
 * the selectable list below. Intentional dormancy (ADR-0075):
 *
 * - `edge` (plan O2): Edge-TTS only works by impersonating the Edge browser (a
 *   token forged from a constant lifted out of the browser, plus a spoofed UA
 *   and `chrome-extension://` Origin). There is no acceptable terms of service
 *   and no key to request, and it returns 403 in mainland China — this
 *   product's market. Its synthesis implementation has been deleted.
 *
 * - `openai-realtime` (plan D2): a pure-TTS use of OpenAI's speech-to-speech
 *   Realtime model, at ~$64/1M audio output vs ~$12 for `gpt-4o-mini-tts`, and
 *   steered by a "read this verbatim" prompt to suppress the model's agency —
 *   the wrong tool. The `openai` provider already uses `gpt-4o-mini-tts` over
 *   REST, so that is the TTS path now. Its former WebSocket transport has been
 *   deleted; live conversation uses the dedicated shared live-voice runtime.
 */
export const RETIRED_TTS_PROVIDERS = [
  "edge",
  "openai-realtime",
] as const satisfies readonly TTSProvider[]

const warnedRetiredProviders = new Set<string>()

export function normalizeTTSProvider(value: unknown): SelectableTTSProvider {
  if (
    typeof value === "string" &&
    (RETIRED_TTS_PROVIDERS as readonly string[]).includes(value) &&
    !warnedRetiredProviders.has(value)
  ) {
    warnedRetiredProviders.add(value)
    console.warn(`TTS provider "${value}" is retired; using "system" instead.`)
  }
  if (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(TTS_PROVIDERS, value) &&
    !(RETIRED_TTS_PROVIDERS as readonly string[]).includes(value)
  ) {
    return value as SelectableTTSProvider
  }
  return "system"
}

/**
 * Stable list of *selectable* TTS provider IDs in display order (system
 * first). Retired providers (see `RETIRED_TTS_PROVIDERS`) are excluded.
 */
export const ORDERED_TTS_PROVIDERS: SelectableTTSProvider[] = [
  "system",
  "openai",
  "local-openai-compatible",
  "gemini",
  "elevenlabs",
  "cartesia",
  "deepgram",
  "xiaomi",
  "mistral",
  "lmnt",
  "hume",
]

export type TTSConfigurationField = "apiKey" | "endpoint" | "model" | "voice"

export interface TTSProviderSettingsDescriptor {
  id: SelectableTTSProvider
  voiceSettingKey: keyof TTSSettings
  voices: readonly { id: string; name: string }[] | null
  fallbackVoice: string
  configurationFields: readonly TTSConfigurationField[]
  supportsSystemControls: boolean
}

/** UI-neutral settings metadata shared by desktop, mobile, and character editors. */
export const TTS_PROVIDER_SETTINGS: Record<SelectableTTSProvider, TTSProviderSettingsDescriptor> = {
  system: {
    id: "system",
    voiceSettingKey: "systemVoice",
    voices: null,
    fallbackVoice: "",
    configurationFields: ["voice"],
    supportsSystemControls: true,
  },
  openai: {
    id: "openai",
    voiceSettingKey: "openaiVoice",
    voices: OPENAI_TTS_VOICES,
    fallbackVoice: "alloy",
    configurationFields: ["apiKey", "model", "voice"],
    supportsSystemControls: false,
  },
  "local-openai-compatible": {
    id: "local-openai-compatible",
    voiceSettingKey: "localOpenaiVoice",
    voices: null,
    fallbackVoice: "",
    configurationFields: ["apiKey", "endpoint", "model", "voice"],
    supportsSystemControls: false,
  },
  gemini: {
    id: "gemini",
    voiceSettingKey: "geminiVoice",
    voices: GEMINI_TTS_VOICES,
    fallbackVoice: "Kore",
    configurationFields: ["apiKey", "model", "voice"],
    supportsSystemControls: false,
  },
  elevenlabs: {
    id: "elevenlabs",
    voiceSettingKey: "elevenlabsVoice",
    voices: ELEVENLABS_TTS_VOICES,
    fallbackVoice: "rachel",
    configurationFields: ["apiKey", "model", "voice"],
    supportsSystemControls: false,
  },
  cartesia: {
    id: "cartesia",
    voiceSettingKey: "cartesiaVoice",
    voices: CARTESIA_TTS_VOICES,
    fallbackVoice: "a0e99841-438c-4a64-b679-ae501e7d6091",
    configurationFields: ["apiKey", "model", "voice"],
    supportsSystemControls: false,
  },
  deepgram: {
    id: "deepgram",
    voiceSettingKey: "deepgramVoice",
    voices: DEEPGRAM_TTS_VOICES,
    fallbackVoice: "aura-2-asteria-en",
    configurationFields: ["apiKey", "voice"],
    supportsSystemControls: false,
  },
  xiaomi: {
    id: "xiaomi",
    voiceSettingKey: "xiaomiVoice",
    voices: XIAOMI_TTS_VOICES,
    fallbackVoice: "mimo_default",
    configurationFields: ["apiKey", "model", "voice"],
    supportsSystemControls: false,
  },
  mistral: {
    id: "mistral",
    voiceSettingKey: "mistralVoiceId",
    voices: null,
    fallbackVoice: "",
    configurationFields: ["apiKey", "model", "voice"],
    supportsSystemControls: false,
  },
  lmnt: {
    id: "lmnt",
    voiceSettingKey: "lmntVoice",
    voices: LMNT_TTS_VOICES,
    fallbackVoice: "lily",
    configurationFields: ["apiKey", "voice"],
    supportsSystemControls: false,
  },
  hume: {
    id: "hume",
    voiceSettingKey: "humeVoice",
    voices: HUME_TTS_VOICES,
    fallbackVoice: "kora",
    configurationFields: ["apiKey", "voice"],
    supportsSystemControls: false,
  },
}

/**
 * SpeechSettings — TTS surface plus the small STT cross-cut (`sttLanguage`)
 * that the orchestrator needs to set `SpeechSynthesisUtterance.lang`. This
 * mirrors Cognia's combined SpeechSettings but keeps unprefixed field
 * names so it lines up with cognia-next's AppSettings.
 */
export interface SpeechSettings extends TTSSettings {
  /** BCP-47 tag — used to set Web Speech API utterance language. */
  sttLanguage: string
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  ...DEFAULT_TTS_SETTINGS,
  sttLanguage: "en-US",
}

/** Per-provider key map used by the orchestrator to look up secrets. */
export type ProviderSettingsMap = Record<string, { apiKey?: string } | undefined> | undefined
