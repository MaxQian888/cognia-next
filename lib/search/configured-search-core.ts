/**
 * Store-independent configured search policy shared by browser hosts and CLI.
 * The renderer wrapper supplies live Zustand settings; CLI supplies its merged
 * config snapshot. This module never imports either host.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { getSearchCache } from "@cognia/web-search/search-cache"
import { normalizeCustomSearchSource, SEARCH_SOURCES } from "@cognia/web-search/search-constants"
import { optimizeSearchQuery } from "@cognia/web-search/search-query-optimizer"
import { search, type UnifiedSearchOptions } from "@cognia/web-search/search-service"
import { applySourceVerificationPolicy } from "@cognia/web-search/source-verification"
import {
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
  const searchOptions: UnifiedSearchOptions = {
    ...defaultSearchOptions(settings),
    ...overrides,
    provider,
    providerSettings: overrides.providerSettings ?? settings?.searchProviders,
    fallbackEnabled: overrides.fallbackEnabled ?? settings?.searchFallbackEnabled ?? true,
    maxRetries: overrides.maxRetries ?? settings?.searchMaxRetries,
    preferredProviders,
  }

  const cacheable = request.useCache !== false && settings?.searchCacheEnabled !== false
  const cache = getSearchCache()
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
    const cached = cache.get(query, provider, searchOptions)
    if (cached) return applyVerification(cached)
  }

  const response = await search(query, searchOptions)
  if (cacheable) cache.set(query, response, provider, searchOptions)
  return applyVerification(response)
}
