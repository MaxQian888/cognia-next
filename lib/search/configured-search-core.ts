/**
 * Store-independent configured search policy shared by browser hosts and CLI.
 * The renderer wrapper supplies live Zustand settings; CLI supplies its merged
 * config snapshot. This module never imports either host.
 *
 * Every app search reaches the providers through here, so this is where the
 * one provider whose search is itself a model generation (`google-ai`, a
 * Gemini `:generateContent` per search) gets its generation seam: with Router +
 * Fusion's `utilityLedger` surface on in the settings passed in, that call is
 * reserved and settled on the CallLedger (`lib/ai/ledgered-generation-seam.ts`,
 * ADR-0188 D27). Off, the options are exactly what they were.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { ledgeredGenerationSeam } from "@/lib/ai/ledgered-generation-seam"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { getProviderHealth } from "@cognia/web-search/provider-health"
import { getSearchCache, type SearchCacheKeyOptions } from "@cognia/web-search/search-cache"
import { normalizeCustomSearchSource, SEARCH_SOURCES } from "@cognia/web-search/search-constants"
import { optimizeSearchQuery } from "@cognia/web-search/search-query-optimizer"
import {
  search,
  stripUndefined,
  type UnifiedSearchOptions,
} from "@cognia/web-search/search-service"
import { applySourceVerificationPolicy } from "@cognia/web-search/source-verification"
import {
  getEnabledProviders,
  normalizeSearchProviderHealthSettings,
  SEARCH_PROVIDERS,
  type SearchOptions,
  type SearchProviderType,
  type SearchResponse,
} from "@cognia/web-search/types"

/** The utility-ledger feature id of a generating search; the provider appends its stage. */
export const WEB_SEARCH_GENERATION_FEATURE = "web-search"

/**
 * The app provider a generating search provider bills under, for the ledger's
 * pricing: Google AI search is a Gemini generation on the user's Gemini key.
 */
const GENERATING_SEARCH_PROVIDER_ID = "google"

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
  // Undefined unless `utilityLedger` is on: then nothing is added below.
  const generate = ledgeredGenerationSeam({
    binding: {
      surface: "utilityLedger",
      origin: "utility",
      featureId: WEB_SEARCH_GENERATION_FEATURE,
      providerId: GENERATING_SEARCH_PROVIDER_ID,
      workspaceId: null,
    },
    settings,
  })
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
    // Last, so a caller's own options can never route a generating search
    // around the ledger while the surface is on.
    ...(generate ? { generate } : {}),
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
  // The shared cache key reads flat SearchOptions fields only, so every rung
  // of the precedence ladder inside `search()` has to be folded in here — a
  // changed default would otherwise hit an entry produced under the old one.
  // `stripUndefined` mirrors the merge inside `search()`: an explicit
  // `undefined` in the overrides must not shadow a real lower-rung default.
  //
  // Provider `defaultOptions` are that middle rung. For a pinned provider
  // they fold into the flat fields verbatim — they ARE the effective values
  // there (which also keeps the news-TTL pick in `cache.set` honest). Under
  // auto the serving provider is only decided inside `search()`, so the key
  // additionally carries a canonical digest of every candidate provider's
  // defaults: editing any of them busts the entries they shaped.
  const providerSettings = searchOptions.providerSettings
  const pinnedDefaults = provider
    ? stripUndefined(providerSettings?.[provider]?.defaultOptions ?? {})
    : {}
  const enabledIds = getEnabledProviders(providerSettings ?? {}).map((p) => p.providerId)
  // A pinned provider still falls back to the enabled pool while fallback is
  // on, so every provider that could shape the response feeds the digest.
  const candidateIds = provider ? [provider, ...enabledIds] : enabledIds
  const providerDefaults = Object.fromEntries(
    candidateIds
      .map((id) => [id, stripUndefined(providerSettings?.[id]?.defaultOptions ?? {})] as const)
      .filter(([, defaults]) => Object.keys(defaults).length > 0)
  )
  const cacheKeyOptions: SearchCacheKeyOptions = {
    ...baseOptions,
    ...pinnedDefaults,
    ...stripUndefined(searchOptions),
    providerDefaults,
  }
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
