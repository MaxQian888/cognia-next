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
import {
  getSearchCache,
  opaqueDigest,
  type SearchCacheKeyOptions,
} from "@cognia/web-search/search-cache"
import {
  normalizeCustomSearchSource,
  normalizeSearchDomain,
  SEARCH_SOURCES,
} from "@cognia/web-search/search-constants"
import { optimizeSearchQuery } from "@cognia/web-search/search-query-optimizer"
import {
  filterResponseByDomainPolicy,
  search,
  stripUndefined,
  type UnifiedSearchOptions,
} from "@cognia/web-search/search-service"
import { applySourceVerificationPolicy } from "@cognia/web-search/source-verification"
import { isSafeSearchMandatory } from "@cognia/web-search/search-type-router"
import { isAbortLike } from "@cognia/web-search/operation-policy"
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

/**
 * Version of the search result/cache policy contract. Bumped whenever what a
 * cached entry may contain changes (policy filtering, answer clearing, image
 * filtering), so entries written under an older contract are never served.
 */
export const SEARCH_POLICY_CONTRACT_VERSION = 2

export interface ConfiguredSearchRequest {
  settings?: AppSettings
  options?: UnifiedSearchOptions
  useCache?: boolean
  optimizeQuery?: boolean
  /** Cancels the adapter requests, retries and fallback of this search. */
  signal?: AbortSignal
  /**
   * Runtime/account scope (opaque). Isolates cache entries; with
   * {@link activeScope} it also stops a request started under one account
   * from publishing into another.
   */
  scope?: string
  /** Current scope at completion time; a mismatch discards the result. */
  activeScope?: () => string | undefined
}

/** A search whose scope changed while it was in flight; its result is discarded. */
export class SearchScopeChangedError extends Error {
  constructor() {
    super("Search result discarded: the account or runtime changed during the request")
    this.name = "SearchScopeChangedError"
  }
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

function domainWithin(domain: string, allowed: string[]): boolean {
  return allowed.some((base) => domain === base || domain.endsWith(`.${base}`))
}

/**
 * Callers may narrow host policy, never relax it:
 * - host `strict` safe search (mandatory) cannot be lowered by a caller;
 * - caller include domains are intersected with the host's selected sources;
 * - caller exclude domains are added to the host's, not substituted.
 */
function constrainCallerOptions(
  overrides: UnifiedSearchOptions,
  host: SearchOptions
): UnifiedSearchOptions {
  const constrained: UnifiedSearchOptions = { ...overrides }
  if (host.safeSearch === "strict" && overrides.safeSearch && overrides.safeSearch !== "strict") {
    constrained.safeSearch = "strict"
  }
  const hostInclude = (host.includeDomains ?? [])
    .map(normalizeSearchDomain)
    .filter((d): d is string => d !== null)
  if (overrides.includeDomains && hostInclude.length > 0) {
    const narrowed = overrides.includeDomains
      .map(normalizeSearchDomain)
      .filter((d): d is string => d !== null && domainWithin(d, hostInclude))
    // Nothing the caller named is inside the host's sources: keep the host's.
    constrained.includeDomains = narrowed.length > 0 ? narrowed : hostInclude
  }
  if (overrides.excludeDomains && host.excludeDomains?.length) {
    constrained.excludeDomains = [...new Set([...host.excludeDomains, ...overrides.excludeDomains])]
  }
  return constrained
}

/**
 * Opaque revision of everything that decides which providers may serve and
 * how, without any raw secret: eligible ids, engines, endpoints, models,
 * credential digests, and the policy-contract version.
 */
function searchPolicyRevision(settings: AppSettings | undefined): string {
  const providers = getEnabledProviders(settings?.searchProviders ?? {})
    .map((p) =>
      [
        p.providerId,
        p.engine ?? "",
        p.baseUrl ?? "",
        p.allowPrivateEndpoint ? "grant" : "",
        p.model ?? "",
        p.cx ? opaqueDigest(p.cx) : "",
        opaqueDigest([p.apiKey, ...(p.apiKeys ?? [])].join("\u0000")),
      ].join(":")
    )
    .join(";")
  return `v${SEARCH_POLICY_CONTRACT_VERSION}|${providers}`
}

/**
 * Hard result policy, applied to every response INCLUDING cache hits: the
 * user's blocklist / credibility filter (source verification) and the
 * request's include/exclude domains, over results and images. When any
 * grounding result is removed the provider's synthesized `answer` is cleared —
 * it may cite a removed page, and re-deriving one would be a separate model
 * call the user did not ask to pay for.
 */
function applyResultPolicy(
  response: SearchResponse,
  settings: AppSettings | undefined,
  effective: SearchOptions
): SearchResponse {
  const domainFiltered = filterResponseByDomainPolicy(
    response,
    effective.includeDomains,
    effective.excludeDomains
  )
  const policy = settings?.sourceVerificationSettings
  const verified = applySourceVerificationPolicy(domainFiltered.results, policy)
  const blocked = policy?.enabled
    ? (policy.blockedDomains ?? []).map(normalizeSearchDomain).filter((d): d is string => !!d)
    : []
  const images = blocked.length
    ? domainFiltered.images?.filter((image) => {
        try {
          const host = new URL(image.url).hostname.toLowerCase().replace(/^www\./, "")
          return !domainWithin(host, blocked)
        } catch {
          return false
        }
      })
    : domainFiltered.images
  const removedResults = domainFiltered.results.length - verified.length
  const removedImages = (domainFiltered.images?.length ?? 0) - (images?.length ?? 0)
  if (removedResults === 0 && removedImages === 0) {
    return verified === domainFiltered.results
      ? domainFiltered
      : { ...domainFiltered, results: verified }
  }
  return {
    ...domainFiltered,
    results: verified,
    images: images && images.length > 0 ? images : undefined,
    totalResults: verified.length,
    answer: removedResults > 0 ? undefined : domainFiltered.answer,
    diagnostics: {
      ...(domainFiltered.diagnostics ?? {}),
      ...(removedResults > 0 && domainFiltered.answer
        ? { answerCleared: "policy-filtered" as const }
        : {}),
      removedByPolicy: {
        results: (domainFiltered.diagnostics?.removedByPolicy?.results ?? 0) + removedResults,
        images: (domainFiltered.diagnostics?.removedByPolicy?.images ?? 0) + removedImages,
      },
    },
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

  // Host-level defaults ride `baseOptions` (the lowest precedence rung inside
  // `search()`), NOT the call-time spread: a provider's own `defaultOptions`
  // must still beat them, and only the remaining `...overrides` fields count
  // as caller intent.
  const baseOptions = defaultSearchOptions(settings)
  const overrides = constrainCallerOptions(request.options ?? {}, baseOptions)
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
  const searchOptions: UnifiedSearchOptions = {
    ...overrides,
    provider,
    providerSettings: overrides.providerSettings ?? settings?.searchProviders,
    fallbackEnabled: overrides.fallbackEnabled ?? settings?.searchFallbackEnabled ?? true,
    maxRetries: overrides.maxRetries ?? settings?.searchMaxRetries,
    preferredProviders,
    baseOptions,
    ...(request.signal ? { abortSignal: request.signal } : {}),
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
  const {
    abortSignal: _abortSignal,
    generate: _generate,
    providerSettings: _providerSettings,
    baseOptions: _baseOptions,
    ...keyableOptions
  } = searchOptions
  const effective: SearchOptions = {
    ...baseOptions,
    ...pinnedDefaults,
    ...stripUndefined(keyableOptions),
  }
  const cacheKeyOptions: SearchCacheKeyOptions = {
    ...effective,
    providerDefaults,
    safeSearchRequired: isSafeSearchMandatory(effective) || undefined,
    allowFallback: searchOptions.allowFallback === false ? false : undefined,
    scope: request.scope,
    policyRevision: searchPolicyRevision(
      settings && overrides.providerSettings
        ? {
            ...settings,
            searchProviders: overrides.providerSettings as AppSettings["searchProviders"],
          }
        : settings
    ),
  }
  if (cacheable) {
    cache.setConfig({
      ...(settings?.searchCacheTTL ? { defaultTTL: settings.searchCacheTTL } : {}),
      ...(settings?.searchCacheMaxEntries ? { maxSize: settings.searchCacheMaxEntries } : {}),
    })
    const cached = cache.get(query, provider, cacheKeyOptions)
    if (cached) {
      const hit = applyResultPolicy(cached, settings, effective)
      return { ...hit, diagnostics: { ...(hit.diagnostics ?? {}), cacheHit: true } }
    }
  }

  const response = await search(query, searchOptions)
  // Final authority check: a cancelled request publishes nothing and writes
  // nothing, and a request that outlived its scope is discarded.
  const callerSignal = request.signal ?? overrides.signal
  if (callerSignal?.aborted) {
    throw callerSignal.reason instanceof Error && isAbortLike(callerSignal.reason)
      ? callerSignal.reason
      : new DOMException("Aborted", "AbortError")
  }
  if (request.activeScope && request.activeScope() !== request.scope) {
    throw new SearchScopeChangedError()
  }
  if (cacheable) cache.set(query, response, provider, cacheKeyOptions)
  return applyResultPolicy(response, settings, effective)
}
