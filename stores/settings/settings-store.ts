"use client"

import { create } from "zustand"
import type { AppSettings, AppLanguage, AppTheme, BuiltinToolsConfig } from "@/lib/claude/types"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import type { ColorThemePreset, CustomTheme } from "@/types/plugin/plugin-extended"
import type { BackgroundSettings, ImportedThemeRecord, Wallpaper } from "@/types/appearance"
import { DEFAULT_BACKGROUND_SETTINGS } from "@/types/appearance"
import type { CustomProviderDefinition, ProviderSettingsEntry } from "@/lib/ai/provider-consumption"
import type {
  CustomModelMetadata,
  CustomProviderSettings,
  ProviderModelUsageEntry,
  ProviderUIPreferences,
  UserProviderSettings,
} from "@/types/provider/provider"

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
import { restartSidecar, setApiKey } from "@/lib/claude/ipc"
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

interface SettingsState {
  settings: AppSettings | null
  loaded: boolean
  /**
   * In-memory mirror of the OS keyring (Tauri) or web-fallback Dexie store
   * for TTS provider API keys. Populated once during `load()` and updated
   * via `setProviderApiKey` / `clearProviderApiKey`. The orchestrator reads
   * keys from here so playback paths don't pay an IPC round-trip per chunk.
   */
  providerKeys: Partial<Record<KeyringProviderId, string>>
  load: () => Promise<void>
  save: (patch: Partial<Omit<AppSettings, "id">>) => Promise<void>
  toggleAlwaysAllow: (toolName: string, allow: boolean) => Promise<void>
  /**
   * Toggle a single category in `AppSettings.builtinTools`. The next agent
   * turn picks up the change via `lib/claude/build-options.ts`. Returns the
   * promise from `saveSettings` so callers can await persistence.
   */
  setBuiltinToolEnabled: (category: keyof BuiltinToolsConfig, enabled: boolean) => Promise<void>
  /**
   * Persist the API key to Dexie *and* push it down to the Rust process. If
   * the key changed, also tells the sidecar to restart so the SDK re-reads
   * `ANTHROPIC_API_KEY` on next spawn.
   */
  setApiKey: (key: string | null) => Promise<void>

  // ---- TTS provider keys + per-field shortcuts ----
  setProviderApiKey: (provider: KeyringProviderId, key: string) => Promise<void>
  clearProviderApiKey: (provider: KeyringProviderId) => Promise<void>
  refreshProviderKeys: () => Promise<void>

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

  setTheme: (mode: AppTheme) => Promise<void>
  setColorTheme: (preset: ColorThemePreset) => Promise<void>
  setLanguage: (language: AppLanguage) => Promise<void>

  createCustomTheme: (theme: Omit<CustomTheme, "id">) => string
  updateCustomTheme: (id: string, updates: Partial<CustomTheme>) => void
  deleteCustomTheme: (id: string) => void
  setActiveCustomTheme: (id: string | null) => void

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
    apiProtocol: import("@/types/provider/provider").ApiProtocol
    customModels: string[]
    defaultModel?: string
    enabled?: boolean
    customModelMetadata?: Record<string, import("@/types/provider/provider").CustomModelMetadata>
    discoveredModels?: import("@/types/provider/provider").ProviderModelDiscoveryEntry[]
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
  importedVscodeThemes: ImportedThemeRecord[]

  setBackground: (patch: Partial<BackgroundSettings>) => Promise<void>
  addWallpaper: (wallpaper: Wallpaper) => Promise<void>
  updateWallpaper: (id: string, patch: Partial<Wallpaper>) => Promise<void>
  deleteWallpaper: (id: string) => Promise<void>
  setActiveWallpaper: (id: string | null) => Promise<void>
  setCustomCss: (css: string) => Promise<void>
  setCustomCssEnabled: (enabled: boolean) => Promise<void>
  addImportedTheme: (record: ImportedThemeRecord) => Promise<void>
  removeImportedTheme: (customThemeId: string) => Promise<void>
}

const DEFAULTS: AppSettings = {
  id: "singleton",
  permissionMode: "default",
  alwaysAllowTools: [],
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
}

async function syncApiKeyToTauri(key: string | null | undefined) {
  if (!isTauri()) return
  try {
    await setApiKey(key && key.trim() ? key : null)
  } catch (err) {
    console.warn("setApiKey failed", err)
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
  background: BackgroundSettings
  wallpapers: Wallpaper[]
  customCss: string
  customCssEnabled: boolean
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
    background: { ...DEFAULT_BACKGROUND_SETTINGS, ...(s?.background ?? {}) },
    wallpapers: s?.wallpapers ?? [],
    customCss: s?.customCss ?? "",
    customCssEnabled: s?.customCssEnabled ?? false,
    importedVscodeThemes: s?.importedVscodeThemes ?? [],
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
    ...deriveFlatPluginFields(null),

    load: async () => {
      if (get().loaded) return
      try {
        const raw = await getSettings()
        const s = repairImportedVscodeThemes(raw)
        // If the repair produced changes, persist them so subsequent loads
        // observe the cleaned-up state. The repair is purely subtractive
        // (drops orphans / collapses duplicate sourceKey rows) so it never
        // loses the user's intent.
        if (s.importedVscodeThemes !== raw.importedVscodeThemes) {
          await saveSettings({ importedVscodeThemes: s.importedVscodeThemes })
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
            const { applyProxyToRust } = await import("@/stores/network-proxy")
            await applyProxyToRust(s.networkProxy)
          } catch (err) {
            console.warn("networkProxy.applyToRust failed", err)
          }
        }
        // Load TTS provider keys from the OS keyring (Tauri) / Dexie fallback.
        // Failures here are non-fatal; missing keys are surfaced in the UI.
        try {
          const keys = await loadAllProviderKeys()
          set({ providerKeys: keys })
        } catch (err) {
          console.warn("tts.loadAllProviderKeys failed", err)
        }
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
        set({ providerKeys: keys })
      } catch (err) {
        console.warn("refreshProviderKeys failed", err)
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
    },

    setColorTheme: async (preset) => {
      const next = await saveSettings({ colorTheme: preset })
      set({ settings: next })
    },

    setLanguage: async (language) => {
      const next = await saveSettings({ language })
      set({ settings: next })
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

    setDefaultProvider: async (providerId) => {
      const next = await saveSettings({ defaultProvider: providerId })
      set({ settings: next })
      // Phase D wiring: push the newly-selected provider's credentials to
      // the sidecar so the next chat send uses them. Sidecar does an atomic
      // env restart via `claude_set_provider_env` (Rust). Skipped on web.
      if (isTauri()) {
        const cfg =
          next.providerSettings?.[providerId] ??
          next.customProviders?.find((p) => p.id === providerId)
        try {
          const { setProviderEnv } = await import("@/lib/claude/ipc")
          await setProviderEnv(cfg?.apiKey ?? null, cfg?.baseURL ?? null)
        } catch (err) {
          console.warn("setProviderEnv failed", err)
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
      // `apiKey` or `baseURL`, push the change to the sidecar so the next
      // chat turn picks it up without requiring a default-provider switch.
      if (
        isTauri() &&
        next.defaultProvider === providerId &&
        ("apiKey" in patch || "baseURL" in patch)
      ) {
        const cfg = map[providerId]
        try {
          const { setProviderEnv } = await import("@/lib/claude/ipc")
          await setProviderEnv(cfg?.apiKey ?? null, cfg?.baseURL ?? null)
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
