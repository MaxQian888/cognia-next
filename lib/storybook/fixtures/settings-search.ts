// Storybook-only fixture builders for the search settings panels
// (`components/settings/search/**`). These components read the global
// `useSettingsStore` and fall back to library defaults when `settings` is null,
// so stories seed a realistic `AppSettings`-shaped blob covering only the
// search-related fields the panels actually touch. The full `AppSettings` type
// is large; we build the subset the search UI reads and cast through `unknown`,
// mirroring the pattern in `components/chat/composer/web-search-toggle.stories.tsx`.
import type { AppSettings } from "@cognia/agent-config-types"
import {
  type SearchProviderType,
  type SearchProviderSettings,
  type SourceVerificationSettings,
  type SearchUsageEntry,
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  DEFAULT_SOURCE_VERIFICATION_SETTINGS,
  createDefaultSearchUsageStats,
} from "@cognia/web-search/types"

/** Per-provider override applied on top of `DEFAULT_SEARCH_PROVIDER_SETTINGS`. */
export type ProviderOverride = Partial<SearchProviderSettings>

/**
 * Build the `searchProviders` record, applying per-provider overrides on top of
 * the library defaults so configured/enabled providers are easy to express:
 *
 *   makeProviders({ tavily: { apiKey: "tvly-demo-key-123456", enabled: true } })
 */
export function makeProviders(
  overrides: Partial<Record<SearchProviderType, ProviderOverride>> = {}
): Record<SearchProviderType, SearchProviderSettings> {
  const base = structuredClone(DEFAULT_SEARCH_PROVIDER_SETTINGS)
  for (const [id, patch] of Object.entries(overrides) as [SearchProviderType, ProviderOverride][]) {
    base[id] = { ...base[id], ...patch }
  }
  return base
}

/** A pair of fully configured + enabled providers (Tavily primary, Brave secondary). */
export function makeConfiguredProviders(): Record<SearchProviderType, SearchProviderSettings> {
  return makeProviders({
    tavily: { apiKey: "tvly-demo-key-1234567890", enabled: true, priority: 1 },
    brave: { apiKey: "brave-demo-key-1234567890", enabled: true, priority: 2 },
  })
}

/** Source-verification settings with sensible non-empty domain rules. */
export function makeVerificationSettings(
  overrides: Partial<SourceVerificationSettings> = {}
): SourceVerificationSettings {
  return { ...DEFAULT_SOURCE_VERIFICATION_SETTINGS, ...overrides }
}

/** Usage stats with a couple of providers showing real activity. */
export function makePopulatedUsageStats(): Record<SearchProviderType, SearchUsageEntry> {
  const stats = createDefaultSearchUsageStats()
  stats.tavily = {
    searchCount: 142,
    lastUsedAt: Date.UTC(2026, 5, 28, 9, 30),
    totalResponseTime: 142 * 820,
    errorCount: 3,
  }
  stats.brave = {
    searchCount: 57,
    lastUsedAt: Date.UTC(2026, 5, 27, 14, 5),
    totalResponseTime: 57 * 610,
    errorCount: 0,
  }
  return stats
}

/**
 * Build an `AppSettings`-shaped blob carrying the search fields the panels read.
 * Only the search subset is populated; the cast is intentional and limited to
 * Storybook seeding (the store falls back to defaults for everything untouched).
 */
export function makeSearchAppSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const base = {
    searchEnabled: true,
    searchMaxResults: 5,
    searchFallbackEnabled: true,
    defaultSearchProvider: "tavily",
    defaultSearchSources: [],
    customSearchSources: [],
    searchProviders: makeProviders(),
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
    searchCacheTTL: 600_000,
    searchCacheMaxEntries: 500,
    searchSafeSearchEnabled: true,
    searchSafeSearchLevel: "moderate",
    sourceVerificationSettings: makeVerificationSettings(),
    searchUsageStats: createDefaultSearchUsageStats(),
  }
  return { ...base, ...overrides } as unknown as AppSettings
}
