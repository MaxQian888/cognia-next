"use client"

import { create } from "zustand"
import type { AppSettings, AppLanguage, AppTheme, BuiltinToolsConfig } from "@/lib/claude/types"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import type { ColorThemePreset, CustomTheme } from "@/types/plugin/plugin"
import type {
  AutoModeSettings,
  BackgroundSettings,
  CustomCssScope,
  ImportedThemeRecord,
  MonacoLinkSettings,
  Wallpaper,
} from "@/types/appearance"
import {
  DEFAULT_AUTOMODE,
  DEFAULT_BACKGROUND_SETTINGS,
  DEFAULT_MONACO_LINK,
} from "@/types/appearance"
import type {
  CustomModelMetadata,
  CustomProviderSettings,
  ProviderModelUsageEntry,
  ProviderUIPreferences,
  UserProviderSettings,
} from "@cognia/provider-types/provider"

// Re-export rich provider types so existing components that import them
// from "@/stores/settings/settings-store" (matching Cognia's pattern)
// resolve cleanly without rewiring every component.
export type {
  CustomModelMetadata,
  CustomProviderSettings,
  ProviderModelUsageEntry,
  ProviderUIPreferences,
  UserProviderSettings,
}
import { addAlwaysAllow, getSettings, removeAlwaysAllow, saveSettings } from "@/lib/db/settings"
import {
  resolveSkillPanelPrefs,
  type PartialLastSkillView,
  type PartialSkillPanelPrefs,
  type SkillPanelPrefs,
} from "@/lib/skills/preferences"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import { restartSidecar, setApiKey, setProviderEnv } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"
import type {
  CustomSearchSource,
  SafeSearchLevel,
  SearchDepth,
  SearchProviderSettings,
  SearchProviderType,
  SearchRecency,
  SearchType,
  SearchUsageEntry,
  SourceVerificationSettings,
} from "@/lib/search/types"
import {
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  createDefaultSearchUsageEntry,
  createDefaultSearchUsageStats,
} from "@/lib/search/types"
import {
  clearProviderKey,
  loadAllProviderKeys,
  setProviderKey,
  type KeyringProviderId,
} from "@/lib/tts/keyring"
import {
  DEFAULT_ROUTING_CONFIG,
  type ModelMapping,
  type RoutingConfig,
} from "@cognia/provider-types/model-mapping"
import type { BuiltInPresetId } from "@cognia/provider-types/routing-presets"
import { DEFAULT_ROUTING_PRESETS_STATE } from "@cognia/provider-types/routing-presets"
import {
  adaptPresetToEnabledProviders,
  getBuiltInPreset,
} from "@cognia/provider-routing/built-in-presets"
import {
  computeEnabledProviderIds,
  seedDefaultMappingsIfNeeded,
} from "@/lib/routing/seed-default-mappings"

interface SettingsState {
  settings: AppSettings | null
  loaded: boolean
  /**
   * In-memory mirror of the OS keyring (Tauri) or web-fallback Dexie store
   * for TTS provider API keys. Populated lazily on first TTS use (or when the
   * speech settings UI mounts) via `ensureProviderKeys`, then updated via
   * `setProviderApiKey` / `clearProviderApiKey`. Kept out of `load()` so the
   * `1 + N` keyring round-trips don't run during app boot — most sessions
   * never touch TTS. The orchestrator reads keys from here so playback paths
   * don't pay an IPC round-trip per chunk.
   */
  providerKeys: Partial<Record<KeyringProviderId, string>>
  /** Whether `ensureProviderKeys` has completed a successful load. */
  providerKeysLoaded: boolean
  load: () => Promise<void>
  save: (patch: Partial<Omit<AppSettings, "id">>) => Promise<void>
  /**
   * Restore settings to their defaults. With `keys`, resets just those keys
   * (per-section reset); without, resets all preferences but keeps credentials
   * and identity fields. Reuses `save` so all persistence side-effects run.
   */
  resetSettings: (keys?: (keyof AppSettings)[]) => Promise<void>
  toggleAlwaysAllow: (toolName: string, allow: boolean) => Promise<void>
  /**
   * Toggle a single category in `AppSettings.builtinTools`. The next agent
   * turn picks up the change via `lib/claude/build-options.ts`. Returns the
   * promise from `saveSettings` so callers can await persistence.
   */
  setBuiltinToolEnabled: (category: keyof BuiltinToolsConfig, enabled: boolean) => Promise<void>
  setWebToolsEnabled: (enabled: boolean) => Promise<void>
  setWebToolsNativeOnAnthropic: (nativeOnAnthropic: boolean) => Promise<void>
  setWebToolsAllowPrivateHosts: (allowPrivateHosts: boolean) => Promise<void>
  setWebToolsAlwaysDistill: (alwaysDistill: boolean) => Promise<void>
  setSkillToolEnabled: (enabled: boolean) => Promise<void>
  setSlashCommandToolEnabled: (enabled: boolean) => Promise<void>
  setTeamCollaborationToolEnabled: (enabled: boolean) => Promise<void>
  /**
   * Persist the API key to Dexie *and* push it down to the Rust process. If
   * the key changed, also tells the sidecar to restart so the SDK re-reads
   * `ANTHROPIC_API_KEY` on next spawn.
   */
  setApiKey: (key: string | null) => Promise<void>

  // ---- TTS provider keys + per-field shortcuts ----
  setProviderApiKey: (provider: KeyringProviderId, key: string) => Promise<void>
  clearProviderApiKey: (provider: KeyringProviderId) => Promise<void>
  /** Force a reload of all provider keys from the keyring/Dexie. */
  refreshProviderKeys: () => Promise<void>
  /**
   * Lazily load provider keys on first TTS use. Idempotent: returns
   * immediately once a load has succeeded. Triggered from the TTS `speak`
   * path and the speech settings UI — never on the boot path.
   */
  ensureProviderKeys: () => Promise<void>

  setTtsEnabled: (enabled: boolean) => Promise<void>
  setTtsProvider: (provider: NonNullable<AppSettings["ttsProvider"]>) => Promise<void>
  setTtsAutoPlay: (enabled: boolean) => Promise<void>
  setTtsRate: (rate: number) => Promise<void>
  setTtsPitch: (pitch: number) => Promise<void>
  setTtsVolume: (volume: number) => Promise<void>

  // ---- Built-in agent runtime actions ----
  /**
   * Toggle automatic routing fallback retries. When `true` (default), a
   * `session_ended` with a transient error and a non-empty
   * `aliasResolution.fallbackEntries` will re-issue the turn against the
   * next entry. Setting `false` keeps the original error visible.
   */
  setRoutingFallbackEnabled: (enabled: boolean) => Promise<void>

  /**
   * Toggle the desktop → cognia CLI auto-sync. When enabled, the desktop
   * pushes its agent config + provider credentials into the CLI home on boot
   * (and immediately on enable). Default off. See `lib/cli-bridge/`.
   */
  setCliBridgeAutoSync: (enabled: boolean) => Promise<void>

  /**
   * Update one or both skill-bundle mirror toggles. Defaults are
   * `{ claude: true, codex: true }` so the writer can rely on a complete
   * pair after this call. The cognia-owned canonical at
   * `<appData>/cognia/skills/<id>/` is always written and is not toggleable.
   */
  setSkillBundleMirrors: (patch: { claude?: boolean; codex?: boolean }) => Promise<void>

  /**
   * Merge a partial Skills-panel preferences patch over the current value and
   * persist. Mirrors `setSkillBundleMirrors`: the resolver applies defaults at
   * read time, so a patch need only carry the changed fields.
   */
  setSkillPanelPrefs: (patch: PartialSkillPanelPrefs) => Promise<void>
  /**
   * Persist the last Skills-panel view snapshot (tab + sort + non-query
   * filters). Callers should only invoke this when `rememberLastView` is on.
   */
  setLastSkillView: (patch: PartialLastSkillView) => Promise<void>

  // ---- Web search actions (all persist via saveSettings) ----
  setSearchEnabled: (v: boolean) => Promise<void>
  setSearchMaxResults: (n: number) => Promise<void>
  setSearchFallbackEnabled: (v: boolean) => Promise<void>
  setDefaultSearchProvider: (p: SearchProviderType) => Promise<void>
  setSearchProviderEnabled: (id: SearchProviderType, enabled: boolean) => Promise<void>
  setSearchProviderApiKey: (id: SearchProviderType, key: string) => Promise<void>
  setSearchProviderPriority: (id: SearchProviderType, p: number) => Promise<void>
  setSearchProviderSettings: (
    id: SearchProviderType,
    patch: Partial<SearchProviderSettings>
  ) => Promise<void>

  // Default options
  setDefaultSearchType: (t: SearchType) => Promise<void>
  setDefaultSearchDepth: (d: SearchDepth) => Promise<void>
  setDefaultSearchRecency: (r: SearchRecency) => Promise<void>
  setDefaultSearchCountry: (c: string) => Promise<void>
  setDefaultSearchLanguage: (lang: string) => Promise<void>
  setDefaultIncludeDomains: (domains: string[]) => Promise<void>
  setDefaultExcludeDomains: (domains: string[]) => Promise<void>
  setDefaultIncludeAnswer: (v: boolean) => Promise<void>
  setDefaultIncludeRawContent: (v: boolean) => Promise<void>

  // Cache
  setSearchCacheEnabled: (v: boolean) => Promise<void>
  setSearchCacheTTL: (ms: number) => Promise<void>
  setSearchCacheMaxEntries: (n: number) => Promise<void>

  // Safety
  setSearchSafeSearchEnabled: (v: boolean) => Promise<void>
  setSearchSafeSearchLevel: (level: SafeSearchLevel) => Promise<void>

  // Source verification
  setSourceVerificationSettings: (s: SourceVerificationSettings) => Promise<void>

  // Usage tracking
  /**
   * Synchronous: updates the in-memory store immediately and fires a Dexie
   * write in the background. Call sites (the search service) shouldn't
   * await — usage stats are best-effort and shouldn't block search latency.
   */
  incrementSearchUsage: (
    providerId: SearchProviderType,
    responseTime: number,
    success: boolean
  ) => void
  resetSearchUsageStats: () => Promise<void>

  // Custom research sources
  addCustomSearchSource: (s: CustomSearchSource) => Promise<void>
  removeCustomSearchSource: (id: string) => Promise<void>
  setDefaultSearchSources: (ids: string[]) => Promise<void>

  // ---------------------------------------------------------------------------
  // Plugin-facing flat surface
  //
  // The plugin Theme / i18n / AI-provider APIs read these fields directly
  // off `useSettingsStore.getState()`. They are derived from `settings`
  // and kept in sync inside `applySettings()`. Setters write through to
  // Dexie via `saveSettings`, so any update is durable.
  // ---------------------------------------------------------------------------

  theme: AppTheme
  colorTheme: ColorThemePreset
  language: AppLanguage
  customThemes: CustomTheme[]
  activeCustomThemeId: string | null
  defaultProvider: string
  providerSettings: Record<string, UserProviderSettings>
  customProviders: CustomProviderSettings[]
  providerUsageStats: Record<string, ProviderModelUsageEntry[]>
  providerUIPreferences: ProviderUIPreferences
  providerOnboardingDismissed: boolean
  /** ISO 8601 timestamp of when the desktop first-run onboarding dialog was last dismissed/completed. */
  onboardingDismissedAt: string | undefined

  setTheme: (mode: AppTheme) => Promise<void>
  setColorTheme: (preset: ColorThemePreset) => Promise<void>
  setLanguage: (language: AppLanguage) => Promise<void>

  createCustomTheme: (theme: Omit<CustomTheme, "id">) => string
  updateCustomTheme: (id: string, updates: Partial<CustomTheme>) => void
  deleteCustomTheme: (id: string) => void
  setActiveCustomTheme: (id: string | null) => void

  // ---- Alias routing (model mappings / strategy / presets) ----
  /** Merge a patch into `routingConfig` (strategy, constraints, timeouts). */
  setRoutingConfig: (patch: Partial<RoutingConfig>) => Promise<void>
  /** Insert or replace a model-alias mapping (stamps `updatedAt`). */
  upsertModelMapping: (mapping: ModelMapping) => Promise<void>
  removeModelMapping: (mappingId: string) => Promise<void>
  /**
   * Activate a built-in routing preset. Snapshots the current strategy /
   * mappings / config into `routingPresets.preActivationSnapshot` first so
   * `revertRoutingPreset` can undo. `mode` decides whether preset mappings
   * merge into (alias-keyed replace) or wholesale overwrite the existing list.
   */
  activateRoutingPreset: (presetId: BuiltInPresetId, mode: "merge" | "overwrite") => Promise<void>
  /** Restore the pre-activation snapshot (no-op when none exists). */
  revertRoutingPreset: () => Promise<void>

  setDefaultProvider: (providerId: string) => Promise<void>
  setProviderConfig: (providerId: string, patch: Partial<UserProviderSettings>) => Promise<void>
  /** Cognia-compatible alias for `setProviderConfig`. */
  updateProviderSettings: (
    providerId: string,
    patch: Partial<UserProviderSettings>
  ) => Promise<void>
  upsertCustomProvider: (provider: CustomProviderSettings) => Promise<void>
  /**
   * Add a new custom provider (returns its id).
   *
   * Accepts a partial shape — `id` is auto-generated when missing,
   * `providerId` mirrors `id`, and a few `UserProviderSettings`
   * fields default to safe values. This matches Cognia's component
   * call sites which pass only the user-entered fields.
   */
  addCustomProvider: (provider: {
    customName: string
    baseURL: string
    apiKey: string
    apiProtocol: import("@cognia/provider-types/provider").ApiProtocol
    apiFlavor?: import("@cognia/provider-types/provider").ApiFlavor
    customModels: string[]
    defaultModel?: string
    enabled?: boolean
    customModelMetadata?: Record<
      string,
      import("@cognia/provider-types/provider").CustomModelMetadata
    >
    discoveredModels?: import("@cognia/provider-types/provider").ProviderModelDiscoveryEntry[]
    discoveredModelsLastFetched?: number
    id?: string
  }) => Promise<string>
  /** Patch an existing custom provider by id. */
  updateCustomProvider: (
    providerId: string,
    patch: Partial<CustomProviderSettings>
  ) => Promise<void>
  removeCustomProvider: (providerId: string) => Promise<void>
  /** Append a usage entry for a provider/model pair (for the cost tab). */
  recordProviderUsage: (
    providerId: string,
    modelId: string,
    entry: ProviderModelUsageEntry
  ) => Promise<void>
  setProviderUIPreferences: (patch: Partial<ProviderUIPreferences>) => Promise<void>
  dismissProviderOnboarding: () => Promise<void>
  /** Persist the desktop first-run dialog dismissal so it doesn't re-appear on relaunch. */
  dismissOnboarding: () => Promise<void>
  /** Patch provider-level inference defaults (temperature, max tokens, …). */
  setProviderInferenceDefaults: (
    providerId: string,
    patch: Partial<NonNullable<UserProviderSettings["inferenceDefaults"]>>
  ) => Promise<void>
  /** Set a single provider-specific parameter value (reasoning_effort, …). */
  setProviderSpecificParam: (providerId: string, key: string, value: unknown) => Promise<void>
  /** Patch connection params (timeout, retries, concurrency limit). */
  setProviderConnectionParams: (
    providerId: string,
    patch: Partial<NonNullable<UserProviderSettings["connectionParams"]>>
  ) => Promise<void>
  /** Set a single advanced parameter value (response format, seed, …). */
  setProviderAdvancedParam: (providerId: string, key: string, value: unknown) => Promise<void>
  /** Reset all params to undefined for a provider. */
  resetProviderParams: (providerId: string) => Promise<void>
  /** Cognia-compatible alias for `setProviderConfig` (unscoped). */
  setProviderSettings: (providerId: string, patch: Partial<UserProviderSettings>) => Promise<void>

  // ---------------------------------------------------------------------------
  // Appearance: wallpapers, background, custom CSS, VSCode imports.
  // Flat-projected for cheap component subscription.
  // ---------------------------------------------------------------------------

  background: BackgroundSettings
  wallpapers: Wallpaper[]
  customCss: string
  customCssEnabled: boolean
  /** User-CSS injection scope ("app" = wrapped in @scope (#app), "global" = document-wide). */
  customCssScope: CustomCssScope
  /** Monaco/Canvas editor theme linking. */
  monacoLink: MonacoLinkSettings
  /** Automatic light/dark switching (system / schedule / sunset). */
  autoMode: AutoModeSettings
  importedVscodeThemes: ImportedThemeRecord[]

  setBackground: (patch: Partial<BackgroundSettings>) => Promise<void>
  addWallpaper: (wallpaper: Wallpaper) => Promise<void>
  updateWallpaper: (id: string, patch: Partial<Wallpaper>) => Promise<void>
  deleteWallpaper: (id: string) => Promise<void>
  setActiveWallpaper: (id: string | null) => Promise<void>
  setCustomCss: (css: string) => Promise<void>
  setCustomCssEnabled: (enabled: boolean) => Promise<void>
  /** Set the plugin security posture (strict | balanced). Persisted. */
  setPluginSecurityPosture: (posture: "strict" | "balanced") => Promise<void>
  addImportedTheme: (record: ImportedThemeRecord) => Promise<void>
  removeImportedTheme: (customThemeId: string) => Promise<void>
}

const DEFAULTS: AppSettings = {
  id: "singleton",
  permissionMode: "default",
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  updates: { autoCheck: true },
  // Canvas-executed code is confined by default (ADR-0028); independently
  // overridable from Settings → Sandbox.
  canvasCodeSandboxEnabled: true,
}

async function syncApiKeyToTauri(key: string | null | undefined) {
  if (!isTauri()) return
  try {
    await setApiKey(key && key.trim() ? key : null)
  } catch (err) {
    console.warn("setApiKey failed", err)
  }
}

// `claude_set_provider_env` only mutates the sidecar's in-memory env state —
// the running subprocess still has to be restarted for the Anthropic SDK to
// pick up a new ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL (it reads env once, at
// spawn time). Editing the field in Settings fires `setProviderConfig` on
// every keystroke, so restart immediately would kill in-flight turns —
// coalesce rapid edits into a single restart after the user stops typing.
const ANTHROPIC_ENV_RESTART_DEBOUNCE_MS = 800
let anthropicEnvRestartTimer: ReturnType<typeof setTimeout> | null = null
let lastAppliedAnthropicEnv: { apiKey: string | null; baseURL: string | null } | null = null

function scheduleAnthropicSidecarRestart(apiKey: string | null, baseURL: string | null) {
  if (
    lastAppliedAnthropicEnv &&
    lastAppliedAnthropicEnv.apiKey === apiKey &&
    lastAppliedAnthropicEnv.baseURL === baseURL
  ) {
    return
  }
  lastAppliedAnthropicEnv = { apiKey, baseURL }
  if (anthropicEnvRestartTimer) clearTimeout(anthropicEnvRestartTimer)
  anthropicEnvRestartTimer = setTimeout(() => {
    anthropicEnvRestartTimer = null
    restartSidecar().catch((err) => console.warn("restartSidecar failed", err))
  }, ANTHROPIC_ENV_RESTART_DEBOUNCE_MS)
}

/**
 * Record an Anthropic env that was applied via an *immediate* restart (e.g. the
 * provider switch in `setDefaultProvider`). Keeping `lastAppliedAnthropicEnv` in
 * sync means a subsequent identical `setProviderConfig` edit is correctly
 * deduped by `scheduleAnthropicSidecarRestart` instead of triggering a second,
 * redundant debounced restart that could kill an in-flight turn.
 */
function markAnthropicEnvApplied(apiKey: string | null, baseURL: string | null) {
  lastAppliedAnthropicEnv = { apiKey, baseURL }
  if (anthropicEnvRestartTimer) {
    clearTimeout(anthropicEnvRestartTimer)
    anthropicEnvRestartTimer = null
  }
}

/**
 * Repair the `importedVscodeThemes` list on load:
 *
 *  1. Drop orphan records whose `customThemeId` no longer exists in
 *     `customThemes` — those are leftovers from the historical
 *     saveSettings race that committed an import row but lost the
 *     companion theme row.
 *  2. Collapse multiple records with the same `sourceKey` to the most
 *     recently imported one — re-imports of the same VSIX entry used
 *     to produce N copies in History.
 *
 * Returns the same `AppSettings` object when nothing needed repair, so
 * the caller can short-circuit the persist.
 */
export function repairImportedVscodeThemes(s: AppSettings): AppSettings {
  const records = s.importedVscodeThemes ?? []
  if (records.length === 0) return s
  const themeIds = new Set((s.customThemes ?? []).map((c) => c.id))

  // First pass: drop orphans. A record without a matching CustomTheme
  // has nothing to render in the preset grid and confuses both the
  // History list (no swatch / no activate target) and `resolveActiveThemeColors`
  // (active id resolves to no row).
  const live = records.filter((r) => themeIds.has(r.customThemeId))

  // Second pass: collapse duplicate sourceKeys to the newest entry.
  // Records without sourceKey are pre-fix rows — keep them as-is so
  // we don't fold together genuinely distinct sources that happen to
  // share a name.
  const bySourceKey = new Map<string, ImportedThemeRecord>()
  const noSourceKey: ImportedThemeRecord[] = []
  for (const r of live) {
    if (!r.sourceKey) {
      noSourceKey.push(r)
      continue
    }
    const existing = bySourceKey.get(r.sourceKey)
    if (!existing || (r.importedAt ?? 0) > (existing.importedAt ?? 0)) {
      bySourceKey.set(r.sourceKey, r)
    }
  }
  const repaired: ImportedThemeRecord[] = [...noSourceKey, ...bySourceKey.values()]

  if (repaired.length === records.length) return s
  return { ...s, importedVscodeThemes: repaired }
}

/** Get the current `searchProviders` map, falling back to defaults. */
function getProvidersMap(
  s: AppSettings | null
): Record<SearchProviderType, SearchProviderSettings> {
  return s?.searchProviders ?? { ...DEFAULT_SEARCH_PROVIDER_SETTINGS }
}

interface FlatPluginFields {
  theme: AppTheme
  colorTheme: ColorThemePreset
  language: AppLanguage
  customThemes: CustomTheme[]
  activeCustomThemeId: string | null
  defaultProvider: string
  providerSettings: Record<string, UserProviderSettings>
  customProviders: CustomProviderSettings[]
  providerUsageStats: Record<string, ProviderModelUsageEntry[]>
  providerUIPreferences: ProviderUIPreferences
  providerOnboardingDismissed: boolean
  onboardingDismissedAt: string | undefined
  background: BackgroundSettings
  wallpapers: Wallpaper[]
  customCss: string
  customCssEnabled: boolean
  customCssScope: CustomCssScope
  monacoLink: MonacoLinkSettings
  autoMode: AutoModeSettings
  importedVscodeThemes: ImportedThemeRecord[]
}

const DEFAULT_PROVIDER_UI_PREFERENCES: ProviderUIPreferences = {
  statusFilter: "all",
  sortBy: "name",
}

/**
 * Project the plugin-facing flat fields out of an `AppSettings` blob.
 * Called from every place that updates `state.settings` so plugin code
 * reading the flat fields always sees the latest values.
 */
function deriveFlatPluginFields(s: AppSettings | null): FlatPluginFields {
  return {
    theme: s?.theme ?? "system",
    colorTheme: s?.colorTheme ?? "default",
    language: s?.language ?? "en",
    customThemes: s?.customThemes ?? [],
    activeCustomThemeId: s?.activeCustomThemeId ?? null,
    defaultProvider: s?.defaultProvider ?? "",
    providerSettings: s?.providerSettings ?? {},
    customProviders: s?.customProviders ?? [],
    providerUsageStats: s?.providerUsageStats ?? {},
    providerUIPreferences: {
      ...DEFAULT_PROVIDER_UI_PREFERENCES,
      ...(s?.providerUIPreferences ?? {}),
    },
    providerOnboardingDismissed: s?.providerOnboardingDismissed ?? false,
    onboardingDismissedAt: s?.onboardingDismissedAt ?? undefined,
    background: { ...DEFAULT_BACKGROUND_SETTINGS, ...(s?.background ?? {}) },
    wallpapers: s?.wallpapers ?? [],
    customCss: s?.customCss ?? "",
    customCssEnabled: s?.customCssEnabled ?? false,
    customCssScope: s?.customCssScope ?? "app",
    monacoLink: { ...DEFAULT_MONACO_LINK, ...(s?.monacoLink ?? {}) },
    autoMode: { ...DEFAULT_AUTOMODE, ...(s?.autoMode ?? {}) },
    importedVscodeThemes: s?.importedVscodeThemes ?? [],
  }
}

/**
 * Resolve the skill bundle mirror toggles with defaults applied. The
 * canonical `<appData>/cognia/skills/<id>/` write is always on; only the
 * `~/.claude/skills/` and `~/.agents/skills/` mirrors are user-toggleable.
 * Exported as a pure helper so the sync layer can call it without
 * subscribing to the store (the sync layer runs from non-React contexts).
 */
// Re-export the pure skill-panel-prefs resolver (and its types) so components
// and the non-React sync/injection layers can import them from the settings
// store alongside `resolveSkillBundleMirrors` — matching the existing pattern.
export { resolveSkillPanelPrefs }
export type { SkillPanelPrefs, PartialSkillPanelPrefs, PartialLastSkillView }

export function resolveSkillBundleMirrors(settings: AppSettings | null | undefined): {
  claude: boolean
  codex: boolean
} {
  const raw = settings?.skillBundleMirrors
  return {
    claude: raw?.claude ?? true,
    codex: raw?.codex ?? true,
  }
}

export const useSettingsStore = create<SettingsState>((rawSet, get) => {
  // Intercept every state update: if the update modifies `settings`, also
  // re-derive the plugin-facing flat fields. This keeps the two views
  // (nested AppSettings + plugin-flat fields) in lockstep without
  // touching the 30+ existing call sites that only know about
  // `set({ settings: next })`.
  type SetArg = Partial<SettingsState> | ((state: SettingsState) => Partial<SettingsState>)
  const set = (updater: SetArg) => {
    rawSet((state) => {
      const partial =
        typeof updater === "function"
          ? (updater as (s: SettingsState) => Partial<SettingsState>)(state)
          : updater
      if (partial && Object.prototype.hasOwnProperty.call(partial, "settings")) {
        return {
          ...partial,
          ...deriveFlatPluginFields((partial.settings ?? state.settings) as AppSettings | null),
        } as Partial<SettingsState>
      }
      return partial
    })
  }
  return {
    settings: null,
    loaded: false,
    providerKeys: {},
    providerKeysLoaded: false,
    ...deriveFlatPluginFields(null),

    load: async () => {
      if (get().loaded) return
      try {
        const raw = await getSettings()
        const repaired = repairImportedVscodeThemes(raw)
        // Seed default tier aliases (fast/balanced/powerful/reasoning) once for
        // fresh users so the alias-routing engine activates without manual
        // setup. Idempotent: returns the same object when mappings already
        // exist or no providers are enabled.
        const s = seedDefaultMappingsIfNeeded(repaired)
        // Persist whatever the repair + seed changed so subsequent loads observe
        // it. The repair is purely subtractive (drops orphans / collapses
        // duplicate sourceKey rows) and the seed only fills an empty
        // modelMappings, so neither loses the user's intent.
        const patch: Partial<Omit<AppSettings, "id">> = {}
        if (repaired.importedVscodeThemes !== raw.importedVscodeThemes) {
          patch.importedVscodeThemes = repaired.importedVscodeThemes
        }
        if (s.modelMappings !== repaired.modelMappings) {
          patch.modelMappings = s.modelMappings
        }
        if (Object.keys(patch).length > 0) {
          await saveSettings(patch)
        }
        set({ settings: s, loaded: true })
        // Push the API key to the Rust process on first load. The user expects
        // their previously-entered key to be active without a manual save.
        if (s.apiKey) {
          await syncApiKeyToTauri(s.apiKey)
        }
        // Mirror the persisted network proxy config into the Rust
        // `proxy_config::current()` slot so reqwest clients honour it from
        // the very first outbound request. Lazy-import so the network-proxy
        // store doesn't cycle through this file.
        if (s.networkProxy) {
          try {
            const { applyProxyToRust, maybeAutoDetectProxy } =
              await import("@/stores/network-proxy")
            await applyProxyToRust(s.networkProxy)
            // Fire-and-forget: when mode is `auto`, re-probe local proxies and
            // adopt the current port without blocking boot.
            void maybeAutoDetectProxy()
          } catch (err) {
            console.warn("networkProxy.applyToRust failed", err)
          }
        }
        // TTS provider keys are loaded lazily (see `ensureProviderKeys`), NOT
        // here — keeping the `1 + N` keyring round-trips off the boot path.
      } catch (err) {
        console.error("settings.load failed", err)
        set({ settings: DEFAULTS, loaded: true })
      }
    },

    save: async (patch) => {
      const next = await saveSettings(patch)
      set({ settings: next })
      // If the patch touched `networkProxy`, push the new config into the
      // Rust process so reqwest clients see the change before the next
      // outbound call. Other patches don't need this hop.
      if (patch.networkProxy !== undefined) {
        try {
          const { applyProxyToRust } = await import("@/stores/network-proxy")
          await applyProxyToRust(next.networkProxy)
        } catch (err) {
          console.warn("networkProxy.applyToRust failed", err)
        }
      }
    },

    resetSettings: async (keys) => {
      const { buildResetPatch } = await import("@/lib/settings/profile-transfer")
      await get().save(buildResetPatch(keys))
    },

    toggleAlwaysAllow: async (toolName, allow) => {
      if (allow) await addAlwaysAllow(toolName)
      else await removeAlwaysAllow(toolName)
      const s = await getSettings()
      set({ settings: s })
    },

    setBuiltinToolEnabled: async (category, enabled) => {
      const cur = get().settings ?? (await getSettings())
      const builtinTools: BuiltinToolsConfig = {
        ...DEFAULT_BUILTIN_TOOLS,
        ...(cur.builtinTools ?? {}),
        [category]: enabled,
      }
      const next = await saveSettings({ builtinTools })
      set({ settings: next })
    },

    setWebToolsEnabled: async (enabled) => {
      const current = get().settings?.webTools
      const next = await saveSettings({ webTools: { ...current, enabled } })
      set({ settings: next })
    },

    setCliBridgeAutoSync: async (enabled) => {
      const current = get().settings?.cliBridge
      const next = await saveSettings({ cliBridge: { ...current, autoSync: enabled } })
      set({ settings: next })
    },

    setWebToolsNativeOnAnthropic: async (nativeOnAnthropic) => {
      const current = get().settings?.webTools
      const next = await saveSettings({
        webTools: { enabled: current?.enabled ?? true, nativeOnAnthropic },
      })
      set({ settings: next })
    },

    setWebToolsAllowPrivateHosts: async (allowPrivateHosts) => {
      const current = get().settings?.webTools
      const next = await saveSettings({
        webTools: { enabled: current?.enabled ?? true, ...current, allowPrivateHosts },
      })
      set({ settings: next })
    },

    setWebToolsAlwaysDistill: async (alwaysDistill) => {
      const current = get().settings?.webTools
      const next = await saveSettings({
        webTools: { enabled: current?.enabled ?? true, ...current, alwaysDistill },
      })
      set({ settings: next })
    },

    setSkillToolEnabled: async (enabled) => {
      const current = get().settings?.selfInvokeTools
      const next = await saveSettings({ selfInvokeTools: { ...current, skill: enabled } })
      set({ settings: next })
    },

    setSlashCommandToolEnabled: async (enabled) => {
      const current = get().settings?.selfInvokeTools
      const next = await saveSettings({ selfInvokeTools: { ...current, slashCommand: enabled } })
      set({ settings: next })
    },

    setTeamCollaborationToolEnabled: async (enabled) => {
      const current = get().settings?.selfInvokeTools
      const next = await saveSettings({
        selfInvokeTools: { ...current, teamCollaboration: enabled },
      })
      set({ settings: next })
    },

    setApiKey: async (key) => {
      const previous = get().settings?.apiKey ?? undefined
      const trimmed = key && key.trim() ? key.trim() : undefined
      const next = await saveSettings({ apiKey: trimmed })
      set({ settings: next })
      await syncApiKeyToTauri(trimmed ?? null)
      // Only restart if the key actually changed.
      if (previous !== trimmed && isTauri()) {
        try {
          await restartSidecar()
        } catch (err) {
          console.warn("restartSidecar failed", err)
        }
      }
    },

    // ---- Built-in agent runtime ----
    setRoutingFallbackEnabled: async (routingFallbackEnabled) => {
      const next = await saveSettings({ routingFallbackEnabled })
      set({ settings: next })
    },

    setSkillBundleMirrors: async (patch) => {
      const cur = get().settings?.skillBundleMirrors ?? { claude: true, codex: true }
      const skillBundleMirrors = {
        claude: patch.claude ?? cur.claude ?? true,
        codex: patch.codex ?? cur.codex ?? true,
      }
      const next = await saveSettings({ skillBundleMirrors })
      set({ settings: next })
    },

    setSkillPanelPrefs: async (patch) => {
      // Merge over the raw stored partial (not the resolved value) so we only
      // persist fields the user has actually touched.
      const cur = get().settings?.skillPanelPrefs ?? {}
      const skillPanelPrefs = { ...cur, ...patch }
      const next = await saveSettings({ skillPanelPrefs })
      set({ settings: next })
    },

    setLastSkillView: async (patch) => {
      const cur = get().settings?.lastSkillView ?? {}
      const lastSkillView = { ...cur, ...patch }
      const next = await saveSettings({ lastSkillView })
      set({ settings: next })
    },

    // ---- Web search ----
    setSearchEnabled: async (searchEnabled) => {
      const next = await saveSettings({ searchEnabled })
      set({ settings: next })
    },
    setSearchMaxResults: async (searchMaxResults) => {
      const next = await saveSettings({ searchMaxResults })
      set({ settings: next })
    },
    setSearchFallbackEnabled: async (searchFallbackEnabled) => {
      const next = await saveSettings({ searchFallbackEnabled })
      set({ settings: next })
    },
    setDefaultSearchProvider: async (defaultSearchProvider) => {
      const next = await saveSettings({ defaultSearchProvider })
      set({ settings: next })
    },

    setSearchProviderEnabled: async (id, enabled) => {
      const cur = get().settings
      const providers = getProvidersMap(cur)
      const existing = providers[id] ?? { ...DEFAULT_SEARCH_PROVIDER_SETTINGS[id] }
      const updated = { ...providers, [id]: { ...existing, enabled } }
      const next = await saveSettings({ searchProviders: updated })
      set({ settings: next })
    },

    setSearchProviderApiKey: async (id, apiKey) => {
      const cur = get().settings
      const providers = getProvidersMap(cur)
      const existing = providers[id] ?? { ...DEFAULT_SEARCH_PROVIDER_SETTINGS[id] }
      const updated = { ...providers, [id]: { ...existing, apiKey } }
      const next = await saveSettings({ searchProviders: updated })
      set({ settings: next })
    },

    setSearchProviderPriority: async (id, priority) => {
      const cur = get().settings
      const providers = getProvidersMap(cur)
      const existing = providers[id] ?? { ...DEFAULT_SEARCH_PROVIDER_SETTINGS[id] }
      const updated = { ...providers, [id]: { ...existing, priority } }
      const next = await saveSettings({ searchProviders: updated })
      set({ settings: next })
    },

    setSearchProviderSettings: async (id, patch) => {
      const cur = get().settings
      const providers = getProvidersMap(cur)
      const existing = providers[id] ?? { ...DEFAULT_SEARCH_PROVIDER_SETTINGS[id] }
      const updated = { ...providers, [id]: { ...existing, ...patch } }
      const next = await saveSettings({ searchProviders: updated })
      set({ settings: next })
    },

    // Default options
    setDefaultSearchType: async (defaultSearchType) => {
      const next = await saveSettings({ defaultSearchType })
      set({ settings: next })
    },
    setDefaultSearchDepth: async (defaultSearchDepth) => {
      const next = await saveSettings({ defaultSearchDepth })
      set({ settings: next })
    },
    setDefaultSearchRecency: async (defaultSearchRecency) => {
      const next = await saveSettings({ defaultSearchRecency })
      set({ settings: next })
    },
    setDefaultSearchCountry: async (defaultSearchCountry) => {
      const next = await saveSettings({ defaultSearchCountry })
      set({ settings: next })
    },
    setDefaultSearchLanguage: async (defaultSearchLanguage) => {
      const next = await saveSettings({ defaultSearchLanguage })
      set({ settings: next })
    },
    setDefaultIncludeDomains: async (defaultIncludeDomains) => {
      const next = await saveSettings({ defaultIncludeDomains })
      set({ settings: next })
    },
    setDefaultExcludeDomains: async (defaultExcludeDomains) => {
      const next = await saveSettings({ defaultExcludeDomains })
      set({ settings: next })
    },
    setDefaultIncludeAnswer: async (defaultIncludeAnswer) => {
      const next = await saveSettings({ defaultIncludeAnswer })
      set({ settings: next })
    },
    setDefaultIncludeRawContent: async (defaultIncludeRawContent) => {
      const next = await saveSettings({ defaultIncludeRawContent })
      set({ settings: next })
    },

    // Cache
    setSearchCacheEnabled: async (searchCacheEnabled) => {
      const next = await saveSettings({ searchCacheEnabled })
      set({ settings: next })
    },
    setSearchCacheTTL: async (searchCacheTTL) => {
      const next = await saveSettings({ searchCacheTTL })
      set({ settings: next })
    },
    setSearchCacheMaxEntries: async (searchCacheMaxEntries) => {
      const next = await saveSettings({ searchCacheMaxEntries })
      set({ settings: next })
    },

    // Safety
    setSearchSafeSearchEnabled: async (searchSafeSearchEnabled) => {
      const next = await saveSettings({ searchSafeSearchEnabled })
      set({ settings: next })
    },
    setSearchSafeSearchLevel: async (searchSafeSearchLevel) => {
      const next = await saveSettings({ searchSafeSearchLevel })
      set({ settings: next })
    },

    // Source verification
    setSourceVerificationSettings: async (sourceVerificationSettings) => {
      const next = await saveSettings({ sourceVerificationSettings })
      set({ settings: next })
    },

    // Usage tracking — synchronous in-memory update + best-effort persistence.
    incrementSearchUsage: (providerId, responseTime, success) => {
      const cur = get().settings
      if (!cur) return
      const stats: Record<SearchProviderType, SearchUsageEntry> =
        cur.searchUsageStats ?? createDefaultSearchUsageStats()
      const entry = stats[providerId] ?? createDefaultSearchUsageEntry()
      const nextEntry: SearchUsageEntry = {
        searchCount: entry.searchCount + 1,
        lastUsedAt: Date.now(),
        totalResponseTime: entry.totalResponseTime + responseTime,
        errorCount: entry.errorCount + (success ? 0 : 1),
      }
      const updatedStats = { ...stats, [providerId]: nextEntry }
      set({ settings: { ...cur, searchUsageStats: updatedStats } })
      // Background persist; don't block the caller.
      void saveSettings({ searchUsageStats: updatedStats }).catch((err) =>
        console.warn("incrementSearchUsage persist failed", err)
      )
    },

    resetSearchUsageStats: async () => {
      const next = await saveSettings({ searchUsageStats: createDefaultSearchUsageStats() })
      set({ settings: next })
    },

    // Custom research sources
    addCustomSearchSource: async (source) => {
      const cur = get().settings
      const list = cur?.customSearchSources ?? []
      if (list.some((s) => s.id === source.id)) return
      const next = await saveSettings({ customSearchSources: [...list, source] })
      set({ settings: next })
    },
    removeCustomSearchSource: async (id) => {
      const cur = get().settings
      const list = cur?.customSearchSources ?? []
      const next = await saveSettings({
        customSearchSources: list.filter((s) => s.id !== id),
      })
      set({ settings: next })
    },
    setDefaultSearchSources: async (defaultSearchSources) => {
      const next = await saveSettings({ defaultSearchSources })
      set({ settings: next })
    },

    // ---- TTS ----
    setProviderApiKey: async (provider, key) => {
      const trimmed = key.trim()
      await setProviderKey(provider, trimmed)
      set((state) => ({
        providerKeys: {
          ...state.providerKeys,
          [provider]: trimmed.length > 0 ? trimmed : undefined,
        },
      }))
    },

    clearProviderApiKey: async (provider) => {
      await clearProviderKey(provider)
      set((state) => {
        const next = { ...state.providerKeys }
        delete next[provider]
        return { providerKeys: next }
      })
    },

    refreshProviderKeys: async () => {
      try {
        const keys = await loadAllProviderKeys()
        set({ providerKeys: keys, providerKeysLoaded: true })
      } catch (err) {
        console.warn("refreshProviderKeys failed", err)
      }
    },

    ensureProviderKeys: async () => {
      if (get().providerKeysLoaded) return
      try {
        const keys = await loadAllProviderKeys()
        set({ providerKeys: keys, providerKeysLoaded: true })
      } catch (err) {
        // Non-fatal: missing keys are surfaced in the UI. Leave the flag false
        // so a later call retries.
        console.warn("ensureProviderKeys failed", err)
      }
    },

    setTtsEnabled: async (enabled) => {
      const next = await saveSettings({ ttsEnabled: enabled })
      set({ settings: next })
    },
    setTtsProvider: async (provider) => {
      const next = await saveSettings({ ttsProvider: provider })
      set({ settings: next })
    },
    setTtsAutoPlay: async (enabled) => {
      const next = await saveSettings({ ttsAutoPlay: enabled })
      set({ settings: next })
    },
    setTtsRate: async (rate) => {
      const clamped = Math.min(10, Math.max(0.1, rate))
      const next = await saveSettings({ ttsRate: clamped })
      set({ settings: next })
    },
    setTtsPitch: async (pitch) => {
      const clamped = Math.min(2, Math.max(0, pitch))
      const next = await saveSettings({ ttsPitch: clamped })
      set({ settings: next })
    },
    setTtsVolume: async (volume) => {
      const clamped = Math.min(1, Math.max(0, volume))
      const next = await saveSettings({ ttsVolume: clamped })
      set({ settings: next })
    },

    // ---------------------------------------------------------------------------
    // Plugin-facing setters
    // ---------------------------------------------------------------------------

    setTheme: async (mode) => {
      const next = await saveSettings({ theme: mode })
      set({ settings: next })
      emitSystemBusEvent(SystemEvents.THEME_CHANGED, { theme: mode })
    },

    setColorTheme: async (preset) => {
      const next = await saveSettings({ colorTheme: preset })
      set({ settings: next })
      emitSystemBusEvent(SystemEvents.THEME_CHANGED, { colorTheme: preset })
    },

    setLanguage: async (language) => {
      const next = await saveSettings({ language })
      set({ settings: next })
      emitSystemBusEvent(SystemEvents.SETTINGS_CHANGED, { language })
    },

    createCustomTheme: (theme) => {
      const cur = get().settings
      const id = `customtheme_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const list = cur?.customThemes ?? []
      const newTheme: CustomTheme = { ...theme, id }
      const updated = [...list, newTheme]
      set({ settings: { ...(cur ?? DEFAULTS), customThemes: updated } })
      void saveSettings({ customThemes: updated }).catch((err) =>
        console.warn("createCustomTheme persist failed", err)
      )
      return id
    },

    updateCustomTheme: (id, updates) => {
      const cur = get().settings
      const list = cur?.customThemes ?? []
      const idx = list.findIndex((t) => t.id === id)
      if (idx < 0) return
      const next = [...list]
      next[idx] = { ...next[idx], ...updates, id: next[idx].id }
      set({ settings: { ...(cur ?? DEFAULTS), customThemes: next } })
      void saveSettings({ customThemes: next }).catch((err) =>
        console.warn("updateCustomTheme persist failed", err)
      )
    },

    deleteCustomTheme: (id) => {
      const cur = get().settings
      const list = cur?.customThemes ?? []
      const next = list.filter((t) => t.id !== id)
      if (next.length === list.length) return
      const activeCustomThemeId =
        cur?.activeCustomThemeId === id ? null : (cur?.activeCustomThemeId ?? null)
      set({
        settings: {
          ...(cur ?? DEFAULTS),
          customThemes: next,
          activeCustomThemeId,
        },
      })
      void saveSettings({ customThemes: next, activeCustomThemeId }).catch((err) =>
        console.warn("deleteCustomTheme persist failed", err)
      )
    },

    setActiveCustomTheme: (id) => {
      const cur = get().settings
      set({ settings: { ...(cur ?? DEFAULTS), activeCustomThemeId: id } })
      void saveSettings({ activeCustomThemeId: id }).catch((err) =>
        console.warn("setActiveCustomTheme persist failed", err)
      )
    },

    // ---- Alias routing (model mappings / strategy / presets) ----

    setRoutingConfig: async (patch) => {
      const cur = get().settings?.routingConfig ?? DEFAULT_ROUTING_CONFIG
      const next = await saveSettings({ routingConfig: { ...cur, ...patch } })
      set({ settings: next })
    },

    upsertModelMapping: async (mapping) => {
      const list = get().settings?.modelMappings ?? []
      const stamped = { ...mapping, updatedAt: Date.now() }
      const idx = list.findIndex((m) => m.id === mapping.id)
      const updated =
        idx >= 0 ? list.map((m) => (m.id === mapping.id ? stamped : m)) : [...list, stamped]
      const next = await saveSettings({ modelMappings: updated })
      set({ settings: next })
    },

    removeModelMapping: async (mappingId) => {
      const list = get().settings?.modelMappings ?? []
      const next = await saveSettings({ modelMappings: list.filter((m) => m.id !== mappingId) })
      set({ settings: next })
    },

    activateRoutingPreset: async (presetId, mode) => {
      const cur = get().settings
      const preset = getBuiltInPreset(presetId)
      if (!preset) return

      // Adapt to the providers that are actually enabled right now (shared with
      // the fresh-user seeding path). Anthropic works without a providerSettings
      // entry (sidecar OAuth/API key), so it is always considered enabled unless
      // explicitly disabled.
      const enabledIds = computeEnabledProviderIds(cur)
      const adapted = adaptPresetToEnabledProviders(preset, enabledIds)

      const existingMappings = cur?.modelMappings ?? []
      const existingConfig = cur?.routingConfig ?? DEFAULT_ROUTING_CONFIG
      const presets = cur?.routingPresets ?? DEFAULT_ROUTING_PRESETS_STATE

      const now = Date.now()
      const stamped: ModelMapping[] = adapted.mappings.map((m, i) => ({
        ...m,
        id: `${preset.id}-${m.alias}-${now + i}`,
        createdAt: now,
        updatedAt: now,
      }))

      // Merge = preset aliases replace same-alias mappings, everything else
      // survives. Overwrite = the preset's list wins wholesale.
      const presetAliases = new Set(stamped.map((m) => m.alias.toLowerCase()))
      const mergedMappings =
        mode === "overwrite"
          ? stamped
          : [
              ...existingMappings.filter((m) => !presetAliases.has(m.alias.toLowerCase())),
              ...stamped,
            ]

      const next = await saveSettings({
        modelMappings: mergedMappings,
        routingConfig: { ...existingConfig, ...adapted.routingConfig, strategy: adapted.strategy },
        routingPresets: {
          ...presets,
          activePresetId: preset.id,
          preActivationSnapshot: {
            strategy: existingConfig.strategy,
            mappings: existingMappings,
            routingConfig: existingConfig,
            timestamp: now,
          },
        },
      })
      set({ settings: next })
    },

    revertRoutingPreset: async () => {
      const cur = get().settings
      const snapshot = cur?.routingPresets?.preActivationSnapshot
      if (!snapshot) return
      const next = await saveSettings({
        modelMappings: snapshot.mappings,
        routingConfig: snapshot.routingConfig,
        routingPresets: {
          ...(cur?.routingPresets ?? DEFAULT_ROUTING_PRESETS_STATE),
          activePresetId: null,
          preActivationSnapshot: null,
        },
      })
      set({ settings: next })
    },

    setDefaultProvider: async (providerId) => {
      const cur = get().settings
      // Keep the (defaultModel, defaultProvider) pair coherent: a stale model
      // from the previous provider would otherwise ride along and be sent to
      // the new provider's base URL. Only rewritten when the current default
      // model isn't servable by the new provider (see the resolver's contract).
      const { resolveDefaultModelForProvider } = await import("@/lib/ai/model-options")
      const syncedModel = resolveDefaultModelForProvider(
        providerId,
        cur?.defaultModel,
        cur?.providerSettings,
        cur?.customProviders
      )
      const next = await saveSettings({
        defaultProvider: providerId,
        ...(syncedModel !== undefined ? { defaultModel: syncedModel } : {}),
      })
      set({ settings: next })
      // `ApiKeyState` (Rust) is an Anthropic-only env slot — only push to it,
      // and only restart the sidecar, when switching TO the Anthropic
      // provider. Every other provider is read fresh per-turn by the ai-sdk
      // dispatch path (`providerCredentials`), so no push/restart is needed
      // and pushing here would silently corrupt the Anthropic env slot.
      if (isTauri() && providerId === "anthropic") {
        const cfg = next.providerSettings?.[providerId]
        const apiKey = cfg?.apiKey ?? null
        const baseURL = cfg?.baseURL ?? null
        try {
          await setProviderEnv(apiKey, baseURL)
          await restartSidecar()
          // We just restarted with this exact env — record it so a following
          // identical config edit doesn't schedule a second debounced restart.
          markAnthropicEnvApplied(apiKey, baseURL)
        } catch (err) {
          console.warn("setProviderEnv/restartSidecar failed", err)
        }
      }
    },

    setProviderConfig: async (providerId, patch) => {
      const cur = get().settings
      const existing =
        cur?.providerSettings?.[providerId] ??
        ({
          providerId,
          enabled: false,
          defaultModel: "",
        } as UserProviderSettings)
      const map = { ...(cur?.providerSettings ?? {}) }
      map[providerId] = { ...existing, ...patch, providerId }
      const next = await saveSettings({ providerSettings: map })
      set({ settings: next })
      // If this is the active default provider AND the patch touched
      // `apiKey` or `baseURL`, push the change to the sidecar and schedule a
      // (debounced) restart so the next chat turn actually picks it up —
      // `ApiKeyState` only holds Anthropic's env, so this only applies when
      // the edited provider IS Anthropic (see `scheduleAnthropicSidecarRestart`).
      if (
        isTauri() &&
        providerId === "anthropic" &&
        next.defaultProvider === providerId &&
        ("apiKey" in patch || "baseURL" in patch)
      ) {
        const cfg = map[providerId]
        const apiKey = cfg?.apiKey ?? null
        const baseURL = cfg?.baseURL ?? null
        try {
          await setProviderEnv(apiKey, baseURL)
          scheduleAnthropicSidecarRestart(apiKey, baseURL)
        } catch (err) {
          console.warn("setProviderEnv failed", err)
        }
      }
    },

    updateProviderSettings: async (providerId, patch) => {
      // Cognia-compatible alias — components written for Cognia call this.
      await get().setProviderConfig(providerId, patch)
    },

    upsertCustomProvider: async (provider) => {
      const cur = get().settings
      const list = cur?.customProviders ?? []
      const idx = list.findIndex((p) => p.id === provider.id)
      const updated =
        idx >= 0 ? list.map((p) => (p.id === provider.id ? provider : p)) : [...list, provider]
      const next = await saveSettings({ customProviders: updated })
      set({ settings: next })
    },

    addCustomProvider: async (provider) => {
      const id = provider.id || `custom-${Date.now().toString(36)}`
      const full: CustomProviderSettings = {
        // UserProviderSettings base
        providerId: id,
        defaultModel: provider.defaultModel ?? provider.customModels[0] ?? "",
        enabled: provider.enabled ?? true,
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        ...(provider.apiFlavor ? { apiFlavor: provider.apiFlavor } : {}),
        // CustomProviderSettings extension
        id,
        isCustom: true,
        name: provider.customName,
        customName: provider.customName,
        customModels: provider.customModels,
        customModelMetadata: provider.customModelMetadata,
        apiProtocol: provider.apiProtocol,
        models: provider.customModels,
        discoveredModels: provider.discoveredModels,
        discoveredModelsLastFetched: provider.discoveredModelsLastFetched,
      }
      await get().upsertCustomProvider(full)
      return id
    },

    updateCustomProvider: async (providerId, patch) => {
      const cur = get().settings
      const list = cur?.customProviders ?? []
      const idx = list.findIndex((p) => p.id === providerId)
      if (idx < 0) return
      const updated = [...list]
      updated[idx] = { ...updated[idx], ...patch, id: providerId, isCustom: true }
      const next = await saveSettings({ customProviders: updated })
      set({ settings: next })
    },

    removeCustomProvider: async (providerId) => {
      const cur = get().settings
      const list = cur?.customProviders ?? []
      const next = await saveSettings({ customProviders: list.filter((p) => p.id !== providerId) })
      set({ settings: next })
    },

    recordProviderUsage: async (providerId, modelId, entry) => {
      const cur = get().settings
      const stats = { ...(cur?.providerUsageStats ?? {}) }
      const key = `${providerId}:${modelId}`
      const list = stats[key] ?? []
      // Cap retained history at 500 newest entries per (provider:model) pair
      // so the singleton row doesn't grow without bound.
      const trimmed = [...list, entry].slice(-500)
      stats[key] = trimmed
      const next = await saveSettings({ providerUsageStats: stats })
      set({ settings: next })
    },

    setProviderUIPreferences: async (patch) => {
      const cur = get().settings
      const merged: ProviderUIPreferences = {
        ...DEFAULT_PROVIDER_UI_PREFERENCES,
        ...(cur?.providerUIPreferences ?? {}),
        ...patch,
      }
      const next = await saveSettings({ providerUIPreferences: merged })
      set({ settings: next })
    },

    dismissProviderOnboarding: async () => {
      const next = await saveSettings({ providerOnboardingDismissed: true })
      set({ settings: next })
    },

    dismissOnboarding: async () => {
      const next = await saveSettings({ onboardingDismissedAt: new Date().toISOString() })
      set({ settings: next })
    },

    setProviderInferenceDefaults: async (providerId, patch) => {
      const cur = get().settings?.providerSettings?.[providerId]
      const merged = { ...(cur?.inferenceDefaults ?? {}), ...patch }
      await get().setProviderConfig(providerId, { inferenceDefaults: merged })
    },

    setProviderSpecificParam: async (providerId, key, value) => {
      const cur = get().settings?.providerSettings?.[providerId]
      const params = { ...(cur?.providerSpecificParams ?? {}) }
      if (value === undefined || value === null || value === "") {
        delete params[key]
      } else {
        params[key] = value
      }
      await get().setProviderConfig(providerId, { providerSpecificParams: params })
    },

    setProviderConnectionParams: async (providerId, patch) => {
      const cur = get().settings?.providerSettings?.[providerId]
      const merged = { ...(cur?.connectionParams ?? {}), ...patch }
      await get().setProviderConfig(providerId, { connectionParams: merged })
    },

    setProviderAdvancedParam: async (providerId, key, value) => {
      const cur = get().settings?.providerSettings?.[providerId]
      const params = { ...(cur?.advancedParams ?? {}) }
      if (value === undefined || value === null || value === "") {
        delete params[key]
      } else {
        params[key] = value
      }
      await get().setProviderConfig(providerId, { advancedParams: params })
    },

    resetProviderParams: async (providerId) => {
      await get().setProviderConfig(providerId, {
        inferenceDefaults: undefined,
        providerSpecificParams: undefined,
        connectionParams: undefined,
        advancedParams: undefined,
      })
    },

    setProviderSettings: async (providerId, patch) => {
      // Cognia compatibility: same as `setProviderConfig`/`updateProviderSettings`.
      await get().setProviderConfig(providerId, patch)
    },

    // ---------------------------------------------------------------------------
    // Appearance setters
    // ---------------------------------------------------------------------------

    setBackground: async (patch) => {
      const cur = get().settings
      const merged: BackgroundSettings = {
        ...DEFAULT_BACKGROUND_SETTINGS,
        ...(cur?.background ?? {}),
        ...patch,
      }
      const next = await saveSettings({ background: merged })
      set({ settings: next })
    },

    addWallpaper: async (wallpaper) => {
      const cur = get().settings
      const list = cur?.wallpapers ?? []
      if (list.some((w) => w.id === wallpaper.id)) return
      const next = await saveSettings({ wallpapers: [...list, wallpaper] })
      set({ settings: next })
    },

    updateWallpaper: async (id, patch) => {
      const cur = get().settings
      const list = cur?.wallpapers ?? []
      const idx = list.findIndex((w) => w.id === id)
      if (idx < 0) return
      const updated = [...list]
      updated[idx] = { ...updated[idx], ...patch, id: updated[idx].id }
      const next = await saveSettings({ wallpapers: updated })
      set({ settings: next })
    },

    deleteWallpaper: async (id) => {
      const cur = get().settings
      const list = cur?.wallpapers ?? []
      const target = list.find((w) => w.id === id)
      // Built-in wallpapers cannot be deleted; ignore silently so callers
      // don't have to special-case them.
      if (!target || target.builtin) return
      const filtered = list.filter((w) => w.id !== id)
      // If the deleted wallpaper was active, clear the activeId so the
      // applier reverts to no-background instead of dangling on a missing id.
      const background = { ...DEFAULT_BACKGROUND_SETTINGS, ...(cur?.background ?? {}) }
      const patch: Partial<AppSettings> = { wallpapers: filtered }
      if (background.activeId === id) {
        patch.background = { ...background, activeId: null, enabled: false }
      }
      const next = await saveSettings(patch)
      set({ settings: next })
    },

    setActiveWallpaper: async (id) => {
      const cur = get().settings
      const background = { ...DEFAULT_BACKGROUND_SETTINGS, ...(cur?.background ?? {}) }
      // Activating a wallpaper auto-enables the background; passing null
      // disables it. This matches the "single switch" mental model in the UI.
      const next = await saveSettings({
        background: { ...background, activeId: id, enabled: id !== null },
      })
      set({ settings: next })
    },

    setCustomCss: async (css) => {
      const next = await saveSettings({ customCss: css })
      set({ settings: next })
    },

    setCustomCssEnabled: async (enabled) => {
      const next = await saveSettings({ customCssEnabled: enabled })
      set({ settings: next })
    },

    setPluginSecurityPosture: async (posture) => {
      const next = await saveSettings({ pluginSecurityPosture: posture })
      set({ settings: next })
    },

    addImportedTheme: async (record) => {
      const cur = get().settings
      const list = cur?.importedVscodeThemes ?? []
      // Dedupe by both customThemeId AND sourceKey: a re-import targets the
      // same record (sourceKey matches) but is committed against the
      // original CustomTheme row, so customThemeId also matches. Prior to
      // sourceKey existing, only customThemeId was used — that filter
      // remains in place for back-compat with rows on disk.
      const filtered = list.filter((r) => {
        if (r.customThemeId === record.customThemeId) return false
        if (record.sourceKey && r.sourceKey === record.sourceKey) return false
        return true
      })
      const next = await saveSettings({
        importedVscodeThemes: [...filtered, record],
      })
      set({ settings: next })
    },

    removeImportedTheme: async (customThemeId) => {
      const cur = get().settings
      const list = cur?.importedVscodeThemes ?? []
      const next = await saveSettings({
        importedVscodeThemes: list.filter((r) => r.customThemeId !== customThemeId),
      })
      set({ settings: next })
    },
  }
})
