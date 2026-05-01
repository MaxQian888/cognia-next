import type { AppSettings, BuiltinToolsConfig } from "@/lib/claude/types"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import { DEFAULT_TTS_SETTINGS } from "@/lib/tts/types"
import {
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  DEFAULT_SOURCE_VERIFICATION_SETTINGS,
  createDefaultSearchUsageStats,
} from "@/lib/search/types"
import { getDb } from "./schema"

const SINGLETON_ID = "singleton" as const

const DEFAULTS: AppSettings = {
  id: SINGLETON_ID,
  defaultModel: undefined,
  defaultSystemPrompt: undefined,
  defaultWorkingDir: undefined,
  permissionMode: "default",
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  apiKey: undefined,
  lastUpdateCheckAt: undefined,
  theme: "system",
  fontScale: "md",
  language: "en",
  reduceMotion: false,
  telemetryEnabled: false,
  sttLanguage: "en-US",
  selectedMicId: undefined,
  // TTS defaults (mirror lib/tts/types.ts → DEFAULT_TTS_SETTINGS).
  ttsProvider: DEFAULT_TTS_SETTINGS.ttsProvider,
  systemVoice: DEFAULT_TTS_SETTINGS.systemVoice,
  openaiVoice: DEFAULT_TTS_SETTINGS.openaiVoice,
  openaiModel: DEFAULT_TTS_SETTINGS.openaiModel,
  openaiSpeed: DEFAULT_TTS_SETTINGS.openaiSpeed,
  openaiInstructions: DEFAULT_TTS_SETTINGS.openaiInstructions,
  geminiVoice: DEFAULT_TTS_SETTINGS.geminiVoice,
  edgeVoice: DEFAULT_TTS_SETTINGS.edgeVoice,
  edgeRate: DEFAULT_TTS_SETTINGS.edgeRate,
  edgePitch: DEFAULT_TTS_SETTINGS.edgePitch,
  elevenlabsVoice: DEFAULT_TTS_SETTINGS.elevenlabsVoice,
  elevenlabsModel: DEFAULT_TTS_SETTINGS.elevenlabsModel,
  elevenlabsStability: DEFAULT_TTS_SETTINGS.elevenlabsStability,
  elevenlabsSimilarityBoost: DEFAULT_TTS_SETTINGS.elevenlabsSimilarityBoost,
  lmntVoice: DEFAULT_TTS_SETTINGS.lmntVoice,
  lmntSpeed: DEFAULT_TTS_SETTINGS.lmntSpeed,
  humeVoice: DEFAULT_TTS_SETTINGS.humeVoice,
  cartesiaVoice: DEFAULT_TTS_SETTINGS.cartesiaVoice,
  cartesiaModel: DEFAULT_TTS_SETTINGS.cartesiaModel,
  cartesiaLanguage: DEFAULT_TTS_SETTINGS.cartesiaLanguage,
  cartesiaSpeed: DEFAULT_TTS_SETTINGS.cartesiaSpeed,
  cartesiaEmotion: DEFAULT_TTS_SETTINGS.cartesiaEmotion,
  deepgramVoice: DEFAULT_TTS_SETTINGS.deepgramVoice,
  ttsEnabled: DEFAULT_TTS_SETTINGS.ttsEnabled,
  ttsRate: DEFAULT_TTS_SETTINGS.ttsRate,
  ttsPitch: DEFAULT_TTS_SETTINGS.ttsPitch,
  ttsVolume: DEFAULT_TTS_SETTINGS.ttsVolume,
  ttsAutoPlay: DEFAULT_TTS_SETTINGS.ttsAutoPlay,
  ttsCacheEnabled: DEFAULT_TTS_SETTINGS.ttsCacheEnabled,
  ttsStreamingEnabled: DEFAULT_TTS_SETTINGS.ttsStreamingEnabled,

  // Web search defaults — providers are all installed-but-disabled until the
  // user enters an API key.
  searchEnabled: false,
  searchMaxResults: 5,
  searchFallbackEnabled: true,
  defaultSearchProvider: "tavily",
  searchProviders: { ...DEFAULT_SEARCH_PROVIDER_SETTINGS },
  defaultSearchType: "general",
  defaultSearchDepth: "basic",
  defaultSearchRecency: "any",
  defaultSearchCountry: "",
  defaultSearchLanguage: "en",
  defaultIncludeDomains: [],
  defaultExcludeDomains: [],
  defaultIncludeAnswer: true,
  defaultIncludeRawContent: false,
  searchCacheEnabled: true,
  searchCacheTTL: 10 * 60 * 1000,
  searchCacheMaxEntries: 500,
  searchSafeSearchEnabled: true,
  searchSafeSearchLevel: "moderate",
  sourceVerificationSettings: { ...DEFAULT_SOURCE_VERIFICATION_SETTINGS },
  searchUsageStats: createDefaultSearchUsageStats(),
  customSearchSources: [],
  defaultSearchSources: [],
}

export async function getSettings(): Promise<AppSettings> {
  const row = await getDb().settings.get(SINGLETON_ID)
  // Forward-compat: merge defaults under the persisted row so older installs
  // pick up new fields (e.g., searchProviders) without a schema migration.
  if (!row) return DEFAULTS
  return {
    ...DEFAULTS,
    ...row,
    // Nested objects need their own forward-compat merge — a v1 row that
    // shipped without `builtinTools.shellAdvanced` would otherwise drop the
    // default when we eventually add it.
    builtinTools: mergeBuiltinTools(row.builtinTools),
    id: SINGLETON_ID,
  }
}

function mergeBuiltinTools(stored: BuiltinToolsConfig | undefined): BuiltinToolsConfig {
  return { ...DEFAULT_BUILTIN_TOOLS, ...(stored ?? {}) }
}

export async function saveSettings(patch: Partial<Omit<AppSettings, "id">>): Promise<AppSettings> {
  const current = await getSettings()
  const next: AppSettings = { ...current, ...patch, id: SINGLETON_ID }
  await getDb().settings.put(next)
  return next
}

export async function addAlwaysAllow(toolName: string): Promise<void> {
  const cur = await getSettings()
  if (cur.alwaysAllowTools.includes(toolName)) return
  await saveSettings({ alwaysAllowTools: [...cur.alwaysAllowTools, toolName] })
}

export async function removeAlwaysAllow(toolName: string): Promise<void> {
  const cur = await getSettings()
  await saveSettings({
    alwaysAllowTools: cur.alwaysAllowTools.filter((t) => t !== toolName),
  })
}
