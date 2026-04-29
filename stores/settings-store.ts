"use client"

import { create } from "zustand"
import type { AppSettings } from "@/lib/claude/types"
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
}

const DEFAULTS: AppSettings = {
  id: "singleton",
  permissionMode: "default",
  alwaysAllowTools: [],
}

async function syncApiKeyToTauri(key: string | null | undefined) {
  if (!isTauri()) return
  try {
    await setApiKey(key && key.trim() ? key : null)
  } catch (err) {
    console.warn("setApiKey failed", err)
  }
}

/** Get the current `searchProviders` map, falling back to defaults. */
function getProvidersMap(
  s: AppSettings | null
): Record<SearchProviderType, SearchProviderSettings> {
  return s?.searchProviders ?? { ...DEFAULT_SEARCH_PROVIDER_SETTINGS }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loaded: false,
  providerKeys: {},

  load: async () => {
    if (get().loaded) return
    try {
      const s = await getSettings()
      set({ settings: s, loaded: true })
      // Push the API key to the Rust process on first load. The user expects
      // their previously-entered key to be active without a manual save.
      if (s.apiKey) {
        await syncApiKeyToTauri(s.apiKey)
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
  },

  toggleAlwaysAllow: async (toolName, allow) => {
    if (allow) await addAlwaysAllow(toolName)
    else await removeAlwaysAllow(toolName)
    const s = await getSettings()
    set({ settings: s })
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
}))
