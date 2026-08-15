import type {
  AppSettings,
  BuiltinToolsConfig,
  SubscriptionAccountProvider,
} from "@cognia/agent-config-types"
import {
  DEFAULT_BIOMETRIC_GUARD,
  DEFAULT_BUILTIN_TOOLS,
  DEFAULT_LIVE_VOICE_SETTINGS,
  DEFAULT_UPDATE_SETTINGS,
  DEFAULT_USER_PROFILE,
} from "@cognia/agent-config-types"
import { DEFAULT_TTS_SETTINGS, normalizeTTSProvider } from "@cognia/tts/types"
import {
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  DEFAULT_SOURCE_VERIFICATION_SETTINGS,
  createDefaultSearchUsageStats,
} from "@cognia/web-search/types"
import { DEFAULT_APPEARANCE_SLICE, DEFAULT_BACKGROUND_SETTINGS } from "@/types/appearance"
import { DEFAULT_RUN_STATUS_BAR } from "@/lib/chat/run-bar-defaults"
import { DEFAULT_NETWORK_PROXY_SETTINGS } from "@/types/network/proxy"
import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/types/ocr"
import { DEFAULT_GIT_SETTINGS } from "@/types/git"
import { DEFAULT_SIDEBAR_LAYOUT, DEFAULT_SIDEBAR_SIDE } from "@/types/shell/sidebar"
import { DEFAULT_EVAL_SETTINGS } from "@/types/eval/settings"
import { DEFAULT_AUTO_ROUTING, type AutoRoutingSettings } from "@cognia/provider-types/auto-router"
import { DEFAULT_ROUTING_CONFIG } from "@cognia/provider-types/model-mapping"
import { DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES } from "@cognia/provider-types"
import type { DifficultyRoutingSettings } from "@/types/routing/tool-route"
import { getDb, withDbReopenRetry } from "./schema"

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
  // Canvas-executed code is confined by default (ADR-0028); independently
  // overridable from Settings → Sandbox (does not affect chat-tool sandboxing).
  canvasCodeSandboxEnabled: true,
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  routingFallbackEnabled: true,
  autoRouting: { ...DEFAULT_AUTO_ROUTING },
  // Cache-friendly prompt assembly is on by default: volatile per-turn sections
  // (twin RAG, style few-shot, memory recall) are routed to the appended tail so
  // the stable system prefix stays byte-identical across turns and provider
  // prompt caches (Anthropic cache_control, DeepSeek/OpenAI auto-cache) keep
  // hitting. Explicit `false` opts out (mirrors routingFallbackEnabled).
  cacheOptimizationEnabled: true,
  apiKey: undefined,
  apiBaseUrl: undefined,
  activeProviderId: undefined,
  ccswitchSync: {
    enabled: true,
    watchDb: true,
    defaultPropagation: [],
  },
  customLimitsSources: [],
  providerDiagnostics: { ...DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES },
  limitsQueryEnabledAccounts: [],
  lastUpdateCheckAt: undefined,
  updates: { ...DEFAULT_UPDATE_SETTINGS },
  // Multi-provider live voice — off until the user configures a deployment.
  liveVoice: { ...DEFAULT_LIVE_VOICE_SETTINGS },
  browserCookieImportEnabled: false,
  remoteBrowserEnabled: false,
  cliBridge: { autoSync: false },
  webTools: { enabled: true },
  onboardingDismissedAt: undefined,
  theme: "system",
  fontScale: "md",
  language: "en",
  reduceMotion: false,
  workflowEditorPerformanceTier: undefined,
  evalSettings: { ...DEFAULT_EVAL_SETTINGS },
  telemetryEnabled: false,
  behaviorTelemetry: {
    enabled: false,
    destinations: { local: true, remote: false },
    categories: {
      chat: true,
      workflow: true,
      connector: true,
      agentTeam: true,
      system: true,
    },
    sampleRate: 1,
    retentionDays: 30,
    maxStoredEvents: 10_000,
  },
  storageRetention: { traceRetentionDays: 30 },
  sttLanguage: "en-US",
  selectedMicId: undefined,
  pinnedWorkflowIds: [],
  pinnedMeRowIds: [],
  sidebarLayout: DEFAULT_SIDEBAR_LAYOUT,
  // A scalar, so `{ ...DEFAULTS, ...row }` in `getSettings` already seeds it
  // for rows saved before the rail could move — no entry needed alongside the
  // nested-object merges below.
  sidebarSide: DEFAULT_SIDEBAR_SIDE,
  lastInboxViewedAt: 0,
  // TTS defaults (mirror types/media/tts.ts → DEFAULT_TTS_SETTINGS).
  ttsProvider: DEFAULT_TTS_SETTINGS.ttsProvider,
  systemVoice: DEFAULT_TTS_SETTINGS.systemVoice,
  openaiVoice: DEFAULT_TTS_SETTINGS.openaiVoice,
  openaiModel: DEFAULT_TTS_SETTINGS.openaiModel,
  openaiSpeed: DEFAULT_TTS_SETTINGS.openaiSpeed,
  openaiInstructions: DEFAULT_TTS_SETTINGS.openaiInstructions,
  openaiResponseFormat: DEFAULT_TTS_SETTINGS.openaiResponseFormat,
  localOpenaiBaseUrl: DEFAULT_TTS_SETTINGS.localOpenaiBaseUrl,
  localOpenaiModel: DEFAULT_TTS_SETTINGS.localOpenaiModel,
  localOpenaiVoice: DEFAULT_TTS_SETTINGS.localOpenaiVoice,
  localOpenaiSpeed: DEFAULT_TTS_SETTINGS.localOpenaiSpeed,
  localOpenaiResponseFormat: DEFAULT_TTS_SETTINGS.localOpenaiResponseFormat,
  localOpenaiTimeoutMs: DEFAULT_TTS_SETTINGS.localOpenaiTimeoutMs,
  geminiVoice: DEFAULT_TTS_SETTINGS.geminiVoice,
  geminiModel: DEFAULT_TTS_SETTINGS.geminiModel,
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
  xiaomiVoice: DEFAULT_TTS_SETTINGS.xiaomiVoice,
  xiaomiModel: DEFAULT_TTS_SETTINGS.xiaomiModel,
  xiaomiStyle: DEFAULT_TTS_SETTINGS.xiaomiStyle,
  xiaomiDialect: DEFAULT_TTS_SETTINGS.xiaomiDialect,
  mistralVoiceId: DEFAULT_TTS_SETTINGS.mistralVoiceId,
  mistralModel: DEFAULT_TTS_SETTINGS.mistralModel,
  mistralResponseFormat: DEFAULT_TTS_SETTINGS.mistralResponseFormat,
  realtimeVoice: DEFAULT_TTS_SETTINGS.realtimeVoice,
  realtimeModel: DEFAULT_TTS_SETTINGS.realtimeModel,
  realtimeInstructions: DEFAULT_TTS_SETTINGS.realtimeInstructions,
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
  searchMaxRetries: 2,
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

  // Browser/desktop Vault locks after 30 minutes of inactivity by default.
  // Active local turns pause the timer; users may override or disable it.
  accountAutoLockMinutes: 30,

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
  // Conversation sidebar (ChannelList) — comfortable density, no preview line,
  // workspace grouping (the axis conversations are already stamped with) +
  // unread badges on, title-only search (content search is opt-in).
  conversationSidebar: {
    density: "comfortable",
    showPreview: false,
    showCustomIcons: true,
    groupBy: "workspace",
    showUnreadBadges: true,
    searchScope: "title",
  },
  // Token-level streaming for interactive chat — on by default.
  streamPartialMessages: true,
}

export async function getSettings(): Promise<AppSettings> {
  // Retried across a connection close: this read is what every window makes at
  // boot, right when the plugin table bridge closes and reopens the shared
  // Appearance slice (ADR-0029 / ADR-0114 / ADR-0127). `DEFAULT_APPEARANCE_SLICE`
  // is the single default source for the appearance-owned keys; spreading it
  // here is what makes them canonical `DEFAULTS` keys, so per-section reset,
  // the changed-settings review, and profile transfer all see them.
  //
  // `agentFlowMode` is deliberately NOT defaulted: it is the legacy read-only
  // fallback for `messageDisplay` (`resolveMessageDisplayOptions`), and a
  // non-undefined default would override every preset's own agent-flow value.
  ...omitAgentFlowMode(DEFAULT_APPEARANCE_SLICE),
  // Run status bar metrics + composer behavior/assistance (Conversation section)
  // — defaulted here so they are claimable by `SECTION_OWNED_KEYS`.
  runStatusBar: { ...DEFAULT_RUN_STATUS_BAR },
  composerBehavior: {},
  composerAssistance: {},
}

function omitAgentFlowMode(
  slice: typeof DEFAULT_APPEARANCE_SLICE
): Omit<typeof DEFAULT_APPEARANCE_SLICE, "agentFlowMode"> {
  const { agentFlowMode: _legacy, ...rest } = slice
  return rest
  // connection to register plugin stores. Losing it used to strand the whole
  // window on DEFAULTS for the rest of the session (see `withDbReopenRetry`).
  const row = await withDbReopenRetry(() => getDb().settings.get(SINGLETON_ID))
  // Forward-compat: merge defaults under the persisted row so older installs
  // pick up new fields (e.g., searchProviders) without a schema migration.
  if (!row) return DEFAULTS
  const autoRouting = mergeAutoRouting(row.autoRouting, row.difficultyRouting)
  const routingConfig = {
    ...DEFAULT_ROUTING_CONFIG,
    ...(row.routingConfig ?? {}),
    strategy: row.routingConfig?.strategy ?? autoRouting.strategy,
  }
  return {
    ...DEFAULTS,
    ...row,
    ttsProvider: normalizeTTSProvider(row.ttsProvider),
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
    updates: { ...DEFAULT_UPDATE_SETTINGS, ...(row.updates ?? {}) },
    liveVoice: {
      ...DEFAULT_LIVE_VOICE_SETTINGS,
      ...(row.liveVoice ?? {}),
      // Deployments are a replace-not-merge list: spreading defaults under a
      // user's array would resurrect entries they deleted.
      deployments: row.liveVoice?.deployments ?? DEFAULT_LIVE_VOICE_SETTINGS.deployments,
    },
    biometricRequiredFor: {
      ...DEFAULT_BIOMETRIC_GUARD,
      ...(row.biometricRequiredFor ?? {}),
    },
    behaviorTelemetry: {
      ...DEFAULTS.behaviorTelemetry!,
      ...(row.behaviorTelemetry ?? {}),
      enabled:
        row.behaviorTelemetry?.enabled ??
        row.telemetryEnabled ??
        DEFAULTS.behaviorTelemetry!.enabled,
      destinations: {
        ...DEFAULTS.behaviorTelemetry!.destinations,
        ...(row.behaviorTelemetry?.destinations ?? {}),
      },
      categories: {
        ...DEFAULTS.behaviorTelemetry!.categories,
        ...(row.behaviorTelemetry?.categories ?? {}),
      },
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
      reviewAI: {
        enabled: false,
        ...DEFAULT_GIT_SETTINGS.reviewAI,
        ...(row.gitSettings?.reviewAI ?? {}),
      },
      explainAI: {
        enabled: false,
        ...DEFAULT_GIT_SETTINGS.explainAI,
        ...(row.gitSettings?.explainAI ?? {}),
      },
    },
    // Forward-compat: a row saved before sidebar customization existed has no
    // `sidebarLayout` — fall back to the default so the rail renders pinned
    // features + "More". Arrays replace wholesale (an explicit empty `pinned`
    // is a deliberate user choice, not a missing field).
    sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT, ...(row.sidebarLayout ?? {}) },
    // `titleBarLayout` / `statusBarLayout` are deliberately NOT seeded here.
    // "Absent" is load-bearing for them: `components/shell/use-bar-layout.ts`
    // reads it as "this install has never customized the bar" and folds the
    // legacy `barItems` visibility map (persisted by the UI store before the
    // bars became orderable) into the first resolved layout. Defaulting them
    // here would make every existing install look already-customized and throw
    // that choice away.
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
    conversationSidebar: {
      ...DEFAULTS.conversationSidebar,
      ...(row.conversationSidebar ?? {}),
    },
    routingConfig,
    autoRouting: { ...autoRouting, strategy: routingConfig.strategy },
    id: SINGLETON_ID,
  }
}

function mergeAutoRouting(
  stored: Partial<AutoRoutingSettings> | undefined,
  legacyDifficulty: DifficultyRoutingSettings | undefined
): AutoRoutingSettings {
  const strategy =
    stored?.strategy ??
    (legacyDifficulty?.enabled ? ("difficulty" as const) : DEFAULT_AUTO_ROUTING.strategy)
  return {
    ...DEFAULT_AUTO_ROUTING,
    ...(stored ?? {}),
    strategy,
    enabled: stored?.enabled ?? legacyDifficulty?.enabled ?? DEFAULT_AUTO_ROUTING.enabled,
    defaultSelection:
      stored?.defaultSelection ??
      (stored?.enabled === true || legacyDifficulty?.enabled === true
        ? "auto"
        : DEFAULT_AUTO_ROUTING.defaultSelection),
    preferredProviders: stored?.preferredProviders ?? [],
    excludedProviders: stored?.excludedProviders ?? [],
    dataPolicy: {
      ...DEFAULT_AUTO_ROUTING.dataPolicy,
      ...(stored?.dataPolicy ?? {}),
    },
    thresholds: {
      ...DEFAULT_AUTO_ROUTING.thresholds,
      ...(legacyDifficulty?.enabled ? { powerful: legacyDifficulty.threshold } : {}),
      ...(stored?.thresholds ?? {}),
    },
    candidateAliases: stored?.candidateAliases?.length
      ? [...stored.candidateAliases]
      : [...DEFAULT_AUTO_ROUTING.candidateAliases],
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

export interface SaveSettingsOptions {
  /**
   * Whether a paired client should also enqueue this patch for its host.
   *
   * Defaults to `true`: every call site is a user edit, and mirroring is what
   * makes a setting changed on the phone actually reach the desktop. Pass
   * `false` for writes the user did not make — boot-time repairs and seeds —
   * so a local cleanup is not replayed onto the host as an intentional edit.
   */
  mirrorToHost?: boolean
}

export async function saveSettings(
  patch: Partial<Omit<AppSettings, "id">>,
  options: SaveSettingsOptions = {}
): Promise<AppSettings> {
  // Same connection-close exposure as the read, with a worse failure: a patch
  // dropped mid-boot is a setting the user watched themselves change and then
  // lose. The whole read-modify-write retries as a unit — re-reading `current`
  // is what keeps the merge correct on the second pass.
  const next = saveQueue.then(() =>
    withDbReopenRetry(async () => {
      const current = await getSettings()
      const migratedCurrent: AppSettings = {
        ...current,
        defaultAccountIds: current.defaultAccountIds ? { ...current.defaultAccountIds } : undefined,
      }
      migrateLegacyDefaultAccount(migratedCurrent)
      // Bump `updatedAt` on every write so the companion sync source can tell
      // when the singleton changed and re-emit it to paired phones (see
      // `lib/sync/desktop-sync-source.ts:readSettingsDelta`).
      const merged: AppSettings = {
        ...migratedCurrent,
        ...patch,
        id: SINGLETON_ID,
        updatedAt: Date.now(),
      }
      migrateLegacyDefaultAccount(merged)
      await getDb().settings.put(merged)
      // ADR-0090 Phase 1: keep the derived Provider Profile Store fresh.
      // Runs inside the serialized queue so derivations observe writes in
      // order; awaited so a caller that immediately reads profiles sees the
      // updated set, but failures never poison the settings save itself.
      if ("providerSettings" in patch || "customProviders" in patch) {
        try {
          const { syncProviderProfilesFromSettings } =
            await import("@/lib/settings/provider-profile-sync")
          await syncProviderProfilesFromSettings(merged)
        } catch {
          // The profile store is a re-derivable projection; a failed sync is
          // recovered by the next provider-touching save.
        }
      }
      // Mirror the host-writable subset up to the paired host. Outside the
      // retry's critical section in spirit but inside it in code, because the
      // enqueue must not happen if the local write never landed. Failures are
      // swallowed: the local save is the user-visible outcome, and a queue that
      // could not be written is reported by the offline banner, not by making
      // the settings save look like it failed.
      if (options.mirrorToHost !== false) {
        try {
          const { mirrorSettingsPatchToHost } = await import("@/lib/settings/mirror-to-host")
          await mirrorSettingsPatchToHost(patch)
        } catch {
          // Non-fatal — see above.
        }
      }
      return merged
    })
  )
  // Swallow rejection on the queue tail so a single failure doesn't poison
  // every subsequent caller — each awaiter still gets their own rejected
  // Promise via the `next` reference returned below.
  saveQueue = next.catch(() => undefined)
  return next
}

const SUBSCRIPTION_ACCOUNT_PROVIDERS = new Set<SubscriptionAccountProvider>([
  "anthropic",
  "codex",
  "opencode",
])

function normalizeLegacySubscriptionProvider(
  provider: AppSettings["defaultProvider"]
): SubscriptionAccountProvider | null {
  if (provider === "opencode-go") return "opencode"
  return provider && SUBSCRIPTION_ACCOUNT_PROVIDERS.has(provider as SubscriptionAccountProvider)
    ? (provider as SubscriptionAccountProvider)
    : null
}

function migrateLegacyDefaultAccount(settings: AppSettings): void {
  const provider = normalizeLegacySubscriptionProvider(settings.defaultProvider)
  const legacyAccountId = settings.defaultAccountId
  if (!legacyAccountId || !provider) return
  settings.defaultAccountIds = {
    ...settings.defaultAccountIds,
    [provider]: settings.defaultAccountIds?.[provider] ?? legacyAccountId,
  }
  settings.defaultAccountId = undefined
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
