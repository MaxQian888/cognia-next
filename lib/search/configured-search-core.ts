/**
 * Store-independent configured search policy shared by browser hosts and CLI.
 * The renderer wrapper supplies live Zustand settings; CLI supplies its merged
 * config snapshot. This module never imports either host.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { getProviderHealth } from "@cognia/web-search/provider-health"
import { getSearchCache } from "@cognia/web-search/search-cache"
import { normalizeCustomSearchSource, SEARCH_SOURCES } from "@cognia/web-search/search-constants"
import { optimizeSearchQuery } from "@cognia/web-search/search-query-optimizer"
import {
  search,
  stripUndefined,
  type UnifiedSearchOptions,
} from "@cognia/web-search/search-service"
import { applySourceVerificationPolicy } from "@cognia/web-search/source-verification"
import {
  normalizeSearchProviderHealthSettings,
  SEARCH_PROVIDERS,
  type SearchOptions,
  type SearchProviderType,
  type SearchResponse,
} from "@cognia/web-search/types"

export interface ConfiguredSearchRequest {
  settings?: AppSettings
  options?: UnifiedSearchOptions
  useCache?: boolean
  optimizeQuery?: boolean
}

function selectedProviderIds(settings: AppSettings | undefined): SearchProviderType[] {
  const providerIds = new Set(Object.keys(SEARCH_PROVIDERS) as SearchProviderType[])
  return (settings?.defaultSearchSources ?? []).filter((id): id is SearchProviderType =>
    providerIds.has(id as SearchProviderType)
  )
}

function defaultSearchOptions(settings: AppSettings | undefined): SearchOptions {
  const selectedIds = new Set(settings?.defaultSearchSources ?? [])
  const selectedBuiltIns = SEARCH_SOURCES.filter((source) => selectedIds.has(source.id))
  const selectedCustomDomains = (settings?.customSearchSources ?? [])
    .filter((source) => selectedIds.has(source.id))
    .map(normalizeCustomSearchSource)
    .filter((source): source is NonNullable<typeof source> => source !== null)
    .map((source) => source.domain)
  const selectedDomains = [
    ...selectedBuiltIns.filter((source) => source.kind === "domain").map((source) => source.domain),
    ...selectedCustomDomains,
  ]
  return {
    maxResults: settings?.searchMaxResults ?? 5,
    searchType: settings?.defaultSearchType,
    searchDepth: settings?.defaultSearchDepth,
    recency: settings?.defaultSearchRecency,
    country: settings?.defaultSearchCountry,
    language: settings?.defaultSearchLanguage,
    includeDomains: selectedDomains.length > 0 ? selectedDomains : settings?.defaultIncludeDomains,
    excludeDomains: settings?.defaultExcludeDomains,
    includeAnswer: settings?.defaultIncludeAnswer,
    includeRawContent: settings?.defaultIncludeRawContent,
    safeSearch:
      settings?.searchSafeSearchEnabled === false
        ? "off"
        : (settings?.searchSafeSearchLevel ?? "moderate"),
  }
}

export async function searchWithSettings(
  rawQuery: string,
  request: ConfiguredSearchRequest = {}
): Promise<SearchResponse> {
  const settings = request.settings
  const trimmed = rawQuery.trim()
  const optimized =
    request.optimizeQuery === false ? trimmed : optimizeSearchQuery(trimmed) || trimmed
  const query = redactText(optimized).redacted
  if (!hasNoLeakingPii(query)) {
    throw new Error("Search blocked: query contains sensitive data after redaction")
  }

  const overrides = request.options ?? {}
  const preferredProviders = overrides.preferredProviders ?? selectedProviderIds(settings)
  const provider =
    overrides.provider ??
    (preferredProviders.length === 0 ? settings?.defaultSearchProvider : undefined)
  // Host-level defaults ride `baseOptions` (the lowest precedence rung inside
  // `search()`), NOT the call-time spread: a provider's own `defaultOptions`
  // must still beat them, and only the remaining `...overrides` fields count
  // as caller intent.
  const baseOptions = defaultSearchOptions(settings)
  const searchOptions: UnifiedSearchOptions = {
    ...overrides,
    provider,
    providerSettings: overrides.providerSettings ?? settings?.searchProviders,
    fallbackEnabled: overrides.fallbackEnabled ?? settings?.searchFallbackEnabled ?? true,
    maxRetries: overrides.maxRetries ?? settings?.searchMaxRetries,
    preferredProviders,
    baseOptions,
  }

  // Push the persisted circuit-breaker settings into the shared breaker on
  // every call — this is the single funnel both CLI and renderer searches pass
  // through, so an install missing the field gets the defaults here. Above the
  // cache read so the breaker is configured even when the call short-circuits.
  getProviderHealth().setConfig(
    normalizeSearchProviderHealthSettings(settings?.searchProviderHealth)
  )

  const cacheable = request.useCache !== false && settings?.searchCacheEnabled !== false
  const cache = getSearchCache()
  // The shared cache key reads flat SearchOptions fields only, so the base
  // defaults have to be folded back under the call-time fields here — a
  // changed default would otherwise hit an entry produced under the old one.
  // `stripUndefined` mirrors the merge inside `search()`: an explicit
  // `undefined` in the overrides must not shadow a real base default.
  const cacheKeyOptions = { ...baseOptions, ...stripUndefined(searchOptions) }
  const applyVerification = (response: SearchResponse): SearchResponse => {
    const filteredResults = applySourceVerificationPolicy(
      response.results,
      settings?.sourceVerificationSettings
    )
    return filteredResults === response.results
      ? response
      : { ...response, results: filteredResults }
  }
  if (cacheable) {
    cache.setConfig({
      ...(settings?.searchCacheTTL ? { defaultTTL: settings.searchCacheTTL } : {}),
      ...(settings?.searchCacheMaxEntries ? { maxSize: settings.searchCacheMaxEntries } : {}),
    })
    const cached = cache.get(query, provider, cacheKeyOptions)
    if (cached) return applyVerification(cached)
  }

  const response = await search(query, searchOptions)
  if (cacheable) cache.set(query, response, provider, cacheKeyOptions)
  return applyVerification(response)
}
