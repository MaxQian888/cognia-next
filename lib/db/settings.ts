import type { AppSettings, BuiltinToolsConfig } from "@/lib/claude/types"
import {
  DEFAULT_BIOMETRIC_GUARD,
  DEFAULT_BUILTIN_TOOLS,
  DEFAULT_USER_PROFILE,
} from "@/lib/claude/types"
import { DEFAULT_TTS_SETTINGS } from "@/types/media/tts"
import {
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  DEFAULT_SOURCE_VERIFICATION_SETTINGS,
  createDefaultSearchUsageStats,
} from "@/lib/search/types"
import { DEFAULT_BACKGROUND_SETTINGS } from "@/types/appearance"
import { DEFAULT_NETWORK_PROXY_SETTINGS } from "@/types/network/proxy"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/types/ocr"
import { DEFAULT_GIT_SETTINGS } from "@/types/git"
import { DEFAULT_SIDEBAR_LAYOUT } from "@/types/shell/sidebar"
import { getDb } from "./schema"

const SINGLETON_ID = "singleton" as const

/**
 * Canonical default settings. Exported so settings-profile reset/export can
 * diff against and restore them without re-deriving the shape.
 */
export const DEFAULTS: AppSettings = {
  id: SINGLETON_ID,
  defaultModel: undefined,
  defaultSystemPrompt: undefined,
  defaultWorkingDir: undefined,
  activeProjectId: undefined,
  permissionMode: "default",
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  routingFallbackEnabled: true,
  apiKey: undefined,
  apiBaseUrl: undefined,
  activeProviderId: undefined,
  ccswitchSync: {
    enabled: true,
    watchDb: true,
    defaultPropagation: [],
  },
  lastUpdateCheckAt: undefined,
  updates: { autoCheck: true },
  cliBridge: { autoSync: false },
  webTools: { enabled: true },
  onboardingDismissedAt: undefined,
  theme: "system",
  fontScale: "md",
  language: "en",
  reduceMotion: false,
  workflowEditorPerformanceTier: undefined,
  telemetryEnabled: false,
  storageRetention: { traceRetentionDays: 30 },
  sttLanguage: "en-US",
  selectedMicId: undefined,
  pinnedWorkflowIds: [],
  pinnedMeRowIds: [],
  sidebarLayout: DEFAULT_SIDEBAR_LAYOUT,
  lastInboxViewedAt: 0,
  // TTS defaults (mirror types/media/tts.ts → DEFAULT_TTS_SETTINGS).
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
  ttsFallbackEnabled: DEFAULT_TTS_SETTINGS.ttsFallbackEnabled,

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

  // Appearance defaults
  background: { ...DEFAULT_BACKGROUND_SETTINGS },
  wallpapers: [],
  customCss: "",
  customCssEnabled: false,
  importedVscodeThemes: [],

  // Network proxy defaults — disabled until the user configures one.
  networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS },

  // Biometric guard policy — Wave 1.5. Sign-out is on by default
  // (matches the existing pair-onboarding behavior); export and reveal
  // are off until the user opts in via Settings → 应用安全.
  biometricRequiredFor: { ...DEFAULT_BIOMETRIC_GUARD },

  // OCR subsystem preferences. Driven by the settings page at
  // `components/settings/ocr/*`. Mirrors `lib/ocr/types.ts:DEFAULT_OCR_SETTINGS`.
  ocrSettings: { ...DEFAULT_OCR_SETTINGS },

  // Source Control preferences (AI commit message generation, …).
  gitSettings: { ...DEFAULT_GIT_SETTINGS },

  // Local user profile — empty by default; identity falls back to the
  // credential-derived name/avatar (see `lib/profile/use-user-profile.ts`).
  profile: { ...DEFAULT_USER_PROFILE },

  // Conversation title auto-generation — on by default (the instant
  // first-message truncation always runs; this gates the LLM upgrade).
  conversationTitle: { enabled: true },
  // Right-edge timeline minimap — feature on, collapsed by default, label
  // summaries off (they cost one model call per turn).
  conversationTimeline: { enabled: true, expanded: false, labelSummary: { enabled: false } },
  // Token-level streaming for interactive chat — on by default.
  streamPartialMessages: true,
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
    background: { ...DEFAULT_BACKGROUND_SETTINGS, ...(row.background ?? {}) },
    wallpapers: row.wallpapers ?? [],
    customCss: row.customCss ?? "",
    customCssEnabled: row.customCssEnabled ?? false,
    importedVscodeThemes: row.importedVscodeThemes ?? [],
    networkProxy: { ...DEFAULT_NETWORK_PROXY_SETTINGS, ...(row.networkProxy ?? {}) },
    webTools: { enabled: row.webTools?.enabled ?? true },
    cliBridge: { autoSync: row.cliBridge?.autoSync ?? false },
    biometricRequiredFor: {
      ...DEFAULT_BIOMETRIC_GUARD,
      ...(row.biometricRequiredFor ?? {}),
    },
    ocrSettings: mergeOcrSettings(row.ocrSettings),
    storageRetention: {
      traceRetentionDays:
        row.storageRetention?.traceRetentionDays ??
        DEFAULTS.storageRetention?.traceRetentionDays ??
        30,
    },
    gitSettings: {
      ...DEFAULT_GIT_SETTINGS,
      ...(row.gitSettings ?? {}),
      commitMessageAI: {
        ...DEFAULT_GIT_SETTINGS.commitMessageAI,
        ...(row.gitSettings?.commitMessageAI ?? {}),
      },
    },
    // Forward-compat: a row saved before sidebar customization existed has no
    // `sidebarLayout` — fall back to the default so the rail renders pinned
    // features + "More". Arrays replace wholesale (an explicit empty `pinned`
    // is a deliberate user choice, not a missing field).
    sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT, ...(row.sidebarLayout ?? {}) },
    profile: { ...DEFAULT_USER_PROFILE, ...(row.profile ?? {}) },
    conversationTitle: { ...DEFAULTS.conversationTitle, ...(row.conversationTitle ?? {}) },
    conversationTimeline: {
      ...DEFAULTS.conversationTimeline,
      ...(row.conversationTimeline ?? {}),
      labelSummary: {
        ...DEFAULTS.conversationTimeline?.labelSummary,
        ...(row.conversationTimeline?.labelSummary ?? {}),
      },
    },
    id: SINGLETON_ID,
  }
}

/**
 * Forward-compat merge for OCR settings. Nested `platformOverrides` is shallow-
 * merged so adding a new OS bucket in DEFAULT_OCR_SETTINGS surfaces on existing
 * installs without losing the user's manual reorderings.
 */
function mergeOcrSettings(stored: UserOcrSettings | undefined): UserOcrSettings {
  const merged: UserOcrSettings = { ...DEFAULT_OCR_SETTINGS, ...(stored ?? {}) }
  merged.platformOverrides = {
    ...(DEFAULT_OCR_SETTINGS.platformOverrides ?? {}),
    ...(stored?.platformOverrides ?? {}),
  }
  merged.providerConfig = { ...(stored?.providerConfig ?? {}) }
  merged.providerEnabled = { ...(stored?.providerEnabled ?? {}) }
  return merged
}

function mergeBuiltinTools(stored: BuiltinToolsConfig | undefined): BuiltinToolsConfig {
  return { ...DEFAULT_BUILTIN_TOOLS, ...(stored ?? {}) }
}

// Serialize concurrent saveSettings calls. The function is read-modify-write
// at the DB layer (getSettings → merge → put), so two concurrent invocations
// would each `getSettings()` against the same persisted row and the second
// `put` would clobber the first's patch. That race wiped customThemes in
// production when createCustomTheme + setActiveCustomTheme fired together —
// the fire-and-forget setActiveCustomTheme save read stale state and
// overwrote the new theme row. Chaining onto a single tail Promise gives
// us a strict per-process write order without needing a mutex library.
let saveQueue: Promise<unknown> = Promise.resolve()

export async function saveSettings(patch: Partial<Omit<AppSettings, "id">>): Promise<AppSettings> {
  const next = saveQueue.then(async () => {
    const current = await getSettings()
    // Bump `updatedAt` on every write so the companion sync source can tell
    // when the singleton changed and re-emit it to paired phones (see
    // `lib/sync/desktop-sync-source.ts:readSettingsDelta`).
    const merged: AppSettings = { ...current, ...patch, id: SINGLETON_ID, updatedAt: Date.now() }
    await getDb().settings.put(merged)
    return merged
  })
  // Swallow rejection on the queue tail so a single failure doesn't poison
  // every subsequent caller — each awaiter still gets their own rejected
  // Promise via the `next` reference returned below.
  saveQueue = next.catch(() => undefined)
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
