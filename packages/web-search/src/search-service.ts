/**
 * Unified Search Service
 * Provides a unified interface for multi-provider web search
 */

import type {
  SearchProviderType,
  SearchOptions,
  SearchResponse,
  SearchProviderSettings,
  SearchResult,
} from "./types"
import {
  getEnabledProviders,
  isProviderConfigured,
  isProviderRetired,
  SEARCH_PROVIDERS,
} from "./types"
import { normalizeSearchDomain } from "./search-constants"
import { getProviderHealth } from "./provider-health"
import { stripUndefined } from "./strip-undefined"
import { log } from "./log"

import {
  checkProviderEligibility,
  routeSearch,
  SearchCapabilityError,
  isSearchCapabilityError,
} from "./search-type-router"
import {
  createOperationDeadline,
  isAbortLike,
  MAX_OPERATION_ATTEMPTS,
  OperationTimeoutError,
  SEARCH_TOTAL_BUDGET_MS,
} from "./operation-policy"
import { buildKeyPool, pickStartIndex, recordKeyAttempt } from "./key-rotation"
import { classifySearchError, backoffDelay, sleep } from "./retry"
import { testTavilyConnection } from "./providers/tavily"
import { testPerplexityConnection } from "./providers/perplexity"
import { testExaConnection } from "./providers/exa"
import { testSearchAPIConnection } from "./providers/searchapi"
import { testSerperConnection } from "./providers/serper"
import { testSerpAPIConnection } from "./providers/serpapi"
import { testGoogleConnection } from "./providers/google"
import { testGoogleAIConnection } from "./providers/google-ai"
import { testBraveConnection } from "./providers/brave"
import { testDeepSeekConnection } from "./providers/deepseek"
import { testTinyFishConnection } from "./providers/tinyfish"
import { testSearXNGConnection } from "./providers/searxng"

export interface UnifiedSearchOptions extends SearchOptions {
  provider?: SearchProviderType
  /** Providers to try first, in order, before the normal priority-ordered fallback list. */
  preferredProviders?: SearchProviderType[]
  /**
   * May another eligible provider serve the request when the preferred one
   * fails? `provider` is a PREFERENCE under fallback, not a pin; pass `false`
   * (or `allowFallback: false`) for a strict pin that never switches.
   */
  fallbackEnabled?: boolean
  /** Per-call strict-pin control; `false` wins over `fallbackEnabled`. */
  allowFallback?: boolean
  providerSettings?: Partial<Record<SearchProviderType, SearchProviderSettings>>
  /**
   * Host-level defaults (Settings → Search → Behavior). Lowest precedence: a
   * provider's own `defaultOptions` override them, and the remaining call-time
   * fields override both.
   */
  baseOptions?: SearchOptions
  /**
   * Host policy that no lower rung may weaken — neither caller fields nor a
   * provider's own `defaultOptions`. Re-applied after every merge, so it also
   * governs eligibility, the wire request and the host-side result filter:
   * `strict` safe search stays strict, include domains are intersected (an
   * empty intersection fails before I/O) and exclude domains are unioned.
   */
  enforced?: EnforcedSearchPolicy
  /**
   * Max EXTRA attempts per provider on a transient failure (network / 429 / 5xx),
   * beyond the first try. Each extra attempt rotates to the next key in the
   * provider's pool (when multi-key) and waits an exponential backoff. Default 2.
   * A permanent error (e.g. 400/404) never retries; `fallbackEnabled` then moves
   * on to the next provider.
   */
  maxRetries?: number
  /** Base backoff delay in ms for the first retry (default 300, doubling thereafter). */
  retryBackoffMs?: number
  /** Abort the whole search: adapter requests, backoff waits, and fallback. */
  abortSignal?: AbortSignal
  /** Overall budget for this logical search; defaults to `SEARCH_TOTAL_BUDGET_MS`. */
  budgetMs?: number
  /** Adapter attempts across retries AND fallback; defaults to `MAX_OPERATION_ATTEMPTS`. */
  maxAttempts?: number
  /** Injectable RNG for deterministic tests (random rotation / jitter). */
  random?: () => number
}

export interface EnforcedSearchPolicy {
  safeSearch?: "strict"
  includeDomains?: string[]
  excludeDomains?: string[]
}

/** A request whose own domain scope lies wholly outside the host's sources. */
export class SearchDomainPolicyError extends Error {
  constructor() {
    super("None of the requested domains is within the sources allowed in Settings → Search")
    this.name = "SearchDomainPolicyError"
  }
}

function normalizedDomains(values: string[] | undefined): string[] {
  return (values ?? []).map(normalizeSearchDomain).filter((d): d is string => d !== null)
}

function domainWithin(domain: string, allowed: string[]): boolean {
  return allowed.some((base) => domain === base || domain.endsWith(`.${base}`))
}

/**
 * Re-apply host policy over an already merged option set. Pure. When the
 * merged include domains fall wholly outside the host's include list, a
 * caller's own request fails with {@link SearchDomainPolicyError}; a lower
 * rung's default (a provider's `defaultOptions`) simply yields to the host's.
 */
export function applyEnforcedPolicy(
  options: SearchOptions,
  enforced: EnforcedSearchPolicy | undefined,
  { callerIncludeDomains = true }: { callerIncludeDomains?: boolean } = {}
): SearchOptions {
  if (!enforced) return options
  const out: SearchOptions = { ...options }
  if (enforced.safeSearch === "strict") out.safeSearch = "strict"
  const hostInclude = normalizedDomains(enforced.includeDomains)
  if (hostInclude.length > 0) {
    const requested = normalizedDomains(options.includeDomains)
    if (requested.length === 0) {
      out.includeDomains = hostInclude
    } else {
      const narrowed = requested.filter((d) => domainWithin(d, hostInclude))
      if (narrowed.length === 0 && callerIncludeDomains) throw new SearchDomainPolicyError()
      out.includeDomains = narrowed.length > 0 ? narrowed : hostInclude
    }
  }
  const hostExclude = normalizedDomains(enforced.excludeDomains)
  if (hostExclude.length > 0) {
    out.excludeDomains = [...new Set([...hostExclude, ...(options.excludeDomains ?? [])])]
  }
  return out
}

/**
 * Grounding providers (a model generates an answer over its own search) bill a
 * generation per call. They serve a request only when the user chose them —
 * the explicit provider or one of the selected providers — never as an
 * automatic fallback behind an ordinary search provider.
 */
function isAutoFallbackCandidate(
  config: SearchProviderSettings,
  chosen: ReadonlySet<SearchProviderType>
): boolean {
  return (
    SEARCH_PROVIDERS[config.providerId]?.integration !== "grounding" ||
    chosen.has(config.providerId)
  )
}

/** Default extra attempts per provider before falling through to the next one. */
const DEFAULT_MAX_RETRIES = 2

// Re-exported so existing importers through this module keep working; the
// implementation lives in `./strip-undefined` so `search-type-router` can use
// it without closing an import cycle with this file.
export { stripUndefined }

/**
 * Unified search function. Searches using the specified provider or falls
 * back to alternatives. Increments per-provider usage stats via the
 * settings store on every attempt (success or failure).
 */
export async function search(
  query: string,
  options: UnifiedSearchOptions = {}
): Promise<SearchResponse> {
  const {
    provider,
    preferredProviders,
    fallbackEnabled: fallbackSetting = true,
    allowFallback,
    providerSettings,
    baseOptions,
    enforced,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBackoffMs,
    abortSignal,
    budgetMs = SEARCH_TOTAL_BUDGET_MS,
    maxAttempts = MAX_OPERATION_ATTEMPTS,
    random,
    ...searchOptions
  } = options
  const fallbackEnabled = allowFallback === false ? false : fallbackSetting

  if (!providerSettings) {
    throw new Error("Provider settings are required")
  }

  if (provider && isProviderRetired(provider)) {
    throw new SearchCapabilityError(provider, "retired", `Provider ${provider} has been retired`)
  }

  const enabledProviders = getEnabledProviders(providerSettings)

  if (enabledProviders.length === 0) {
    throw new Error("No search providers are enabled")
  }

  let providersToTry: SearchProviderSettings[]

  if (provider) {
    const specificProvider = providerSettings[provider]
    if (!specificProvider?.enabled || !isProviderConfigured(provider, specificProvider)) {
      throw new Error(`Provider ${provider} is not enabled or missing required configuration`)
    }
    providersToTry = orderProviders(
      enabledProviders,
      [provider, ...(preferredProviders ?? [])],
      !fallbackEnabled
    )
  } else {
    providersToTry = orderProviders(enabledProviders, preferredProviders ?? [], false)
  }
  const chosen = new Set<SearchProviderType>([
    ...(provider ? [provider] : []),
    ...(preferredProviders ?? []),
  ])
  providersToTry = providersToTry.filter((config) => isAutoFallbackCandidate(config, chosen))

  // Eligibility is decided per provider against the EFFECTIVE request (host
  // defaults < provider defaults < caller fields) before any I/O. An
  // ineligible provider is skipped — never asked to run a general search in
  // place of a specialized one — and costs no health penalty. When none
  // remains, the first capability error explains why, still with zero network.
  //
  // The one exception is a search type that comes ONLY from the host's global
  // defaults (Settings → Search → default type): that is not the caller's
  // request, so a provider without that vertical runs general search and
  // discloses it as a degraded control instead of becoming unusable.
  const explicitType = (config: SearchProviderSettings) =>
    stripUndefined(searchOptions).searchType ??
    stripUndefined(config.defaultOptions ?? {}).searchType
  const effectiveFor = (config: SearchProviderSettings): SearchOptions => {
    const merged: SearchOptions = applyEnforcedPolicy(
      {
        ...(baseOptions ?? {}),
        ...stripUndefined(config.defaultOptions ?? {}),
        ...stripUndefined(searchOptions),
      },
      enforced,
      { callerIncludeDomains: Boolean(stripUndefined(searchOptions).includeDomains?.length) }
    )
    if (!explicitType(config) && merged.searchType && merged.searchType !== "general") {
      const probe = checkProviderEligibility(config.providerId, config, merged)
      if (probe?.reason === "unsupported-type") return { ...merged, searchType: "general" }
    }
    return merged
  }
  const hostTypeDegraded = (config: SearchProviderSettings, effective: SearchOptions) =>
    !explicitType(config) &&
    Boolean(baseOptions?.searchType && baseOptions.searchType !== "general") &&
    effective.searchType === "general"
  let firstIneligible: SearchCapabilityError | null = null
  const eligible = providersToTry.filter((config) => {
    const problem = checkProviderEligibility(config.providerId, config, effectiveFor(config))
    if (problem && !firstIneligible) firstIneligible = problem
    return problem === null
  })
  if (eligible.length === 0) {
    throw firstIneligible ?? new Error("No search provider can serve this request")
  }
  // A strict pin whose provider is ineligible must not quietly become another.
  if (provider && !fallbackEnabled && eligible[0].providerId !== provider) {
    throw firstIneligible ?? new Error(`Provider ${provider} cannot serve this request`)
  }

  // Circuit breaker: try healthy providers first, pushing still-open (recently
  // failing) providers to the back so a hard-down provider doesn't cost a
  // round-trip on every query. Identity when the breaker is disabled.
  const health = getProviderHealth()
  providersToTry = health.orderByHealth(eligible)

  // One deadline and one attempt budget for the whole logical search: retries
  // and provider fallback draw from the same pool, so neither can multiply it.
  // `signal` on the search options is the same caller cancellation as
  // `abortSignal`; either one cancels the whole operation.
  const callerSignal = abortSignal ?? searchOptions.signal
  const deadline = createOperationDeadline(budgetMs, callerSignal)
  const budget: AttemptBudget = { remaining: Math.max(1, Math.floor(maxAttempts)) }
  const retry: ProviderRetryConfig = {
    maxRetries,
    retryBackoffMs,
    abortSignal: deadline.signal,
    random,
    budget,
  }
  const attempted: SearchProviderType[] = []

  let lastError: Error | null = null
  let lastDomainFilteredResponse: SearchResponse | null = null

  try {
    for (const providerConfig of providersToTry) {
      if (budget.remaining <= 0) break
      if (deadline.signal.aborted) break
      const startTime = Date.now()
      const effective: SearchOptions = { ...effectiveFor(providerConfig), signal: deadline.signal }
      attempted.push(providerConfig.providerId)
      try {
        const result = await attemptProviderWithRotation(query, providerConfig, effective, retry)
        health.recordResult(providerConfig.providerId, true, Date.now() - startTime)
        void recordUsage(providerConfig.providerId, Date.now() - startTime, true)
        const filteredResult = withAttempted(
          filterResponseByDomainPolicy(result, effective.includeDomains, effective.excludeDomains),
          attempted,
          hostTypeDegraded(providerConfig, effective)
        )
        if (filteredResult.results.length > 0 || !hasDomainConstraint(effective.includeDomains)) {
          return filteredResult
        }
        lastDomainFilteredResponse = filteredResult
        if (!fallbackEnabled) return filteredResult
      } catch (error) {
        // A caller-driven abort is not a provider failure — surface it
        // immediately instead of silently trying the next provider.
        if (callerSignal?.aborted) throw error
        if (deadline.timedOut()) break
        if (isAbortError(error)) throw error
        if (isSearchCapabilityError(error)) {
          lastError = error
          if (!fallbackEnabled) break
          continue
        }
        log.warn(`Search with ${providerConfig.providerId} failed`, { error })
        lastError = error instanceof Error ? error : new Error(String(error))
        health.recordResult(providerConfig.providerId, false)
        void recordUsage(providerConfig.providerId, Date.now() - startTime, false)

        if (!fallbackEnabled) {
          break
        }
      }
    }
  } finally {
    deadline.dispose()
  }

  if (lastDomainFilteredResponse) return lastDomainFilteredResponse
  if (deadline.timedOut() && !callerSignal?.aborted) {
    throw new OperationTimeoutError(`Search exceeded its ${Math.round(budgetMs / 1000)}s budget`)
  }
  throw lastError || new Error("All search providers failed")
}

function withAttempted(
  response: SearchResponse,
  attempted: SearchProviderType[],
  typeDegraded = false
): SearchResponse {
  const degraded = response.diagnostics?.degradedControls ?? []
  return {
    ...response,
    diagnostics: {
      ...(response.diagnostics ?? {}),
      attemptedProviders: [...attempted],
      ...(typeDegraded && !degraded.includes("searchType")
        ? { degradedControls: [...degraded, "searchType" as const] }
        : {}),
    },
  }
}

/**
 * `limitToFirst` narrows the list to the single provider the caller pinned.
 * It is NOT simply `!fallbackEnabled`: with no explicit `provider`, disabling
 * fallback has always meant "do not substitute for the provider I named", and
 * since the caller named none, every enabled provider is still tried in
 * priority order. Truncating there silently turned a rate-limited primary into
 * a hard "All search providers failed".
 */
function orderProviders(
  enabledProviders: SearchProviderSettings[],
  preferredProviders: SearchProviderType[],
  limitToFirst: boolean
): SearchProviderSettings[] {
  const byId = new Map(enabledProviders.map((settings) => [settings.providerId, settings]))
  const ordered: SearchProviderSettings[] = []
  const seen = new Set<SearchProviderType>()

  for (const providerId of preferredProviders) {
    const settings = byId.get(providerId)
    if (settings && !seen.has(providerId)) {
      ordered.push(settings)
      seen.add(providerId)
    }
  }
  for (const settings of enabledProviders) {
    if (!seen.has(settings.providerId)) {
      ordered.push(settings)
      seen.add(settings.providerId)
    }
  }

  return limitToFirst ? ordered.slice(0, 1) : ordered
}

function hasDomainConstraint(includeDomains: string[] | undefined): boolean {
  return Boolean(includeDomains?.some((domain) => normalizeSearchDomain(domain) !== null))
}

function urlMatchesIncludedDomains(url: string, includeDomains: string[]): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return false
  }

  return includeDomains.some((value) => {
    const domain = normalizeSearchDomain(value)
    return domain !== null && (hostname === domain || hostname.endsWith(`.${domain}`))
  })
}

function urlMatchesAnyDomain(url: string, domains: string[]): boolean {
  return urlMatchesIncludedDomains(url, domains)
}

/**
 * Apply the request's hard domain policy host-side, whatever the provider did
 * with it at the wire: keep only included domains, drop excluded ones, from
 * results AND images. Providers without a native domain filter would
 * otherwise leak excluded sources.
 */
export function filterResponseByDomainPolicy(
  response: SearchResponse,
  includeDomains: string[] | undefined,
  excludeDomains: string[] | undefined
): SearchResponse {
  const include = hasDomainConstraint(includeDomains) ? (includeDomains ?? []) : null
  const exclude = hasDomainConstraint(excludeDomains) ? (excludeDomains ?? []) : null
  if (!include && !exclude) return response
  // Under a hard source scope an answer with no grounding result left cannot
  // be traced to an allowed source, so it is not returned.
  const ungrounded = (count: number) => include !== null && count === 0 && Boolean(response.answer)

  const keep = (url: string) =>
    (!include || urlMatchesAnyDomain(url, include)) &&
    (!exclude || !urlMatchesAnyDomain(url, exclude))
  const results = response.results.filter((result) => keep(result.url))
  const images = response.images?.filter((image) => keep(image.url))
  const removedResults = response.results.length - results.length
  const removedImages = (response.images?.length ?? 0) - (images?.length ?? 0)
  if (removedResults === 0 && removedImages === 0 && !ungrounded(results.length)) return response

  const clearAnswer = removedResults > 0 || ungrounded(results.length)
  return {
    ...response,
    // The provider synthesized `answer` from the unfiltered result set, so it
    // can cite pages this filter just removed. Keep it only when the filter
    // removed no result and at least one allowed result grounds it.
    answer: clearAnswer ? undefined : response.answer,
    results,
    images: images && images.length > 0 ? images : undefined,
    totalResults: results.length,
    diagnostics: {
      ...(response.diagnostics ?? {}),
      ...(clearAnswer && response.answer ? { answerCleared: "policy-filtered" as const } : {}),
      removedByPolicy: {
        results: (response.diagnostics?.removedByPolicy?.results ?? 0) + removedResults,
        images: (response.diagnostics?.removedByPolicy?.images ?? 0) + removedImages,
      },
    },
  }
}

/** Adapter attempts left in the whole logical operation (retries + fallback). */
interface AttemptBudget {
  remaining: number
}

interface ProviderRetryConfig {
  maxRetries: number
  retryBackoffMs?: number
  abortSignal?: AbortSignal
  random?: () => number
  /** Shared across providers; absent ⇒ only `maxRetries` bounds this provider. */
  budget?: AttemptBudget
}

function isAbortError(error: unknown): boolean {
  return isAbortLike(error)
}

/**
 * Run one provider's search with multi-key rotation + bounded retry. Walks the
 * provider's key pool starting at the rotation-selected index; on a transient
 * failure it advances to the next key and waits an exponential backoff, up to
 * `maxRetries` extra attempts. A permanent error (client 4xx) aborts immediately
 * so the caller's provider-level fallback takes over without wasting retries.
 *
 * The per-provider circuit breaker (`recordResult`) stays outside this loop —
 * it sees one aggregate outcome per provider, not one per key attempt.
 */
async function attemptProviderWithRotation(
  query: string,
  providerConfig: SearchProviderSettings,
  searchOptions: SearchOptions,
  retry: ProviderRetryConfig
): Promise<SearchResponse> {
  const { providerId } = providerConfig
  const pool = buildKeyPool(providerConfig)
  const startIndex = pickStartIndex(providerId, pool, providerConfig, { random: retry.random })
  const maxAttempts = Math.max(1, retry.maxRetries + 1)

  let lastError: unknown = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (retry.budget) {
      if (retry.budget.remaining <= 0) break
      retry.budget.remaining -= 1
    }
    const keyIndex = pool.length > 0 ? (startIndex + attempt) % pool.length : 0
    const apiKey = pool.length > 0 ? pool[keyIndex] : providerConfig.apiKey
    // Reuse the original config reference when the primary key is already the
    // one selected, so callers/tests observing that object see it untouched.
    const attemptConfig =
      apiKey === providerConfig.apiKey ? providerConfig : { ...providerConfig, apiKey }

    if (pool.length > 0) recordKeyAttempt(providerId, apiKey, keyIndex)

    try {
      return await routeSearch(query, providerId, attemptConfig, searchOptions)
    } catch (error) {
      lastError = error
      if (isSearchCapabilityError(error) || retry.abortSignal?.aborted) throw error
      const classification = classifySearchError(error)
      const hasAttemptsLeft =
        attempt < maxAttempts - 1 && (retry.budget ? retry.budget.remaining > 0 : true)
      // An auth/quota rejection is only worth retrying on a DIFFERENT key:
      // re-sending a permanently rejected credential just burns budget.
      const authRejection = classification.status === 401 || classification.status === 403
      const sameKeyNext = pool.length <= 1
      if (!classification.retryable || !hasAttemptsLeft || (authRejection && sameKeyNext)) {
        throw error
      }
      log.warn(`Search attempt failed for ${providerId}, retrying`, {
        attempt: attempt + 1,
        maxAttempts,
        status: classification.status,
        rotateKey: classification.rotateKey,
        poolSize: pool.length,
      })
      await sleep(
        backoffDelay(attempt, { baseMs: retry.retryBackoffMs, random: retry.random }),
        retry.abortSignal
      )
    }
  }

  throw lastError ?? new Error(`Search with ${providerId} failed`)
}

/**
 * Best-effort per-provider usage reporting seam (ADR-0068 E2). The package is
 * framework-agnostic, so the host injects the sink: the app binding
 * (`lib/search/search-service.ts`) registers its settings-store
 * `incrementSearchUsage` action here on import. Unset (CLI, sidecar, tests)
 * it is a no-op — usage stats have always been best-effort.
 */
export type SearchUsageReporter = (
  providerId: SearchProviderType,
  responseTime: number,
  success: boolean
) => void

let usageReporter: SearchUsageReporter | null = null

export function setSearchUsageReporter(reporter: SearchUsageReporter | null): void {
  usageReporter = reporter
}

function recordUsage(providerId: SearchProviderType, responseTime: number, success: boolean): void {
  try {
    usageReporter?.(providerId, responseTime, success)
  } catch {
    // The reporter may touch a store that isn't initialized in non-browser
    // contexts (tests, SSR); ignore — usage stats are best-effort.
  }
}

/**
 * Search with automatic provider selection
 */
export async function autoSearch(
  query: string,
  providerSettings: Record<SearchProviderType, SearchProviderSettings>,
  options: SearchOptions = {}
): Promise<SearchResponse> {
  return search(query, {
    ...options,
    providerSettings,
    fallbackEnabled: true,
  })
}

/**
 * Search with a specific provider (no fallback)
 */
export async function searchWithProvider(
  provider: SearchProviderType,
  query: string,
  apiKey: string,
  options: SearchOptions = {},
  providerSettings?: Partial<SearchProviderSettings>
): Promise<SearchResponse> {
  const settings: SearchProviderSettings = {
    providerId: provider,
    apiKey,
    enabled: true,
    priority: providerSettings?.priority ?? 1,
    defaultOptions: providerSettings?.defaultOptions,
    cx: providerSettings?.cx,
  }

  return routeSearch(query, provider, settings, options)
}

/**
 * Test connection for a specific provider
 */
export async function testProviderConnection(
  provider: SearchProviderType,
  apiKey: string,
  providerSettings?: Partial<SearchProviderSettings>
): Promise<boolean> {
  try {
    switch (provider) {
      case "tavily":
        return await testTavilyConnection(apiKey)
      case "perplexity":
        return await testPerplexityConnection(apiKey)
      case "exa":
        return await testExaConnection(apiKey)
      case "searchapi":
        return await testSearchAPIConnection(apiKey)
      case "serper":
        return await testSerperConnection(apiKey)
      case "serpapi":
        return await testSerpAPIConnection(apiKey)
      case "bing":
        // Retired 2025-08-11: never sends a request.
        return false
      case "google":
        if (!providerSettings?.cx || providerSettings.cx.trim() === "") {
          return false
        }
        return await testGoogleConnection(apiKey, providerSettings.cx)
      case "google-ai":
        return await testGoogleAIConnection(apiKey)
      case "brave":
        return await testBraveConnection(apiKey)
      case "deepseek":
        return await testDeepSeekConnection(apiKey)
      case "tinyfish":
        return await testTinyFishConnection(apiKey)
      case "searxng":
        return await testSearXNGConnection({
          baseUrl: providerSettings?.baseUrl,
          allowPrivateEndpoint: providerSettings?.allowPrivateEndpoint,
          engine: providerSettings?.engine,
        })
      default:
        return false
    }
  } catch {
    return false
  }
}

export interface ProviderKeyTestResult {
  /** 0 = primary key, 1.. = position in `apiKeys` (after dedupe/blank removal). */
  index: number
  ok: boolean
  /** Last 4 chars, for display. */
  keyHint: string
}

/**
 * Test every key in a provider's rotation pool, sequentially — a parallel
 * fan-out would read as a burst to the provider's rate limiter. Returns one
 * row per key so the settings UI can show which backups are dead rather than
 * only validating the primary.
 */
export async function testProviderKeyPool(
  provider: SearchProviderType,
  settings: SearchProviderSettings
): Promise<ProviderKeyTestResult[]> {
  const pool = buildKeyPool(settings)
  // buildKeyPool drops a blank primary; an unconfigured provider still gets a
  // single row so the caller can show "the primary key failed/is missing".
  const keys = pool.length > 0 ? pool : [settings.apiKey]
  const results: ProviderKeyTestResult[] = []
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    results.push({
      index,
      ok: await testProviderConnection(provider, key, settings),
      keyHint: key.slice(-4),
    })
  }
  return results
}

/**
 * Aggregate search results from multiple providers in parallel.
 */
export async function aggregateSearch(
  query: string,
  providerSettings: Record<SearchProviderType, SearchProviderSettings>,
  options: SearchOptions = {}
): Promise<SearchResponse> {
  const enabledProviders = getEnabledProviders(providerSettings)

  if (enabledProviders.length === 0) {
    throw new Error("No search providers are enabled")
  }

  const startTime = Date.now()
  const searchPromises = enabledProviders.map((provider) =>
    routeSearch(query, provider.providerId, provider, options).catch((error) => {
      log.warn(`Aggregate search with ${provider.providerId} failed`, { error })
      return null
    })
  )

  const results = await Promise.all(searchPromises)
  const successfulResults = results.filter((r): r is SearchResponse => r !== null)

  if (successfulResults.length === 0) {
    throw new Error("All search providers failed")
  }

  // Normalize each provider's scores to [0,1] before merging so one provider's
  // scoring scale (e.g. Exa's cosine similarity vs. Tavily's relevance) doesn't
  // dominate the ranking. Single-result / all-equal sets keep their raw scores.
  const aggregatedResults = mergeAndRankResults(
    successfulResults.flatMap((r) => normalizeScores(r.results))
  )

  const answer = successfulResults.find((r) => r.answer)?.answer

  const allImages = successfulResults.filter((r) => r.images).flatMap((r) => r.images || [])

  return {
    provider: successfulResults[0].provider,
    query,
    answer,
    results: aggregatedResults,
    images: allImages.length > 0 ? allImages : undefined,
    responseTime: Date.now() - startTime,
    totalResults: aggregatedResults.length,
  }
}

/**
 * Min-max normalize a single provider's result scores into [0,1]. When every
 * score is equal (including a single result) there's no meaningful spread, so
 * the raw scores are kept — normalizing one value to 1 would discard the
 * provider's own confidence signal.
 */
function normalizeScores(results: SearchResult[]): SearchResult[] {
  if (results.length < 2) return results
  let min = Infinity
  let max = -Infinity
  for (const r of results) {
    if (r.score < min) min = r.score
    if (r.score > max) max = r.score
  }
  const range = max - min
  if (range <= 0) return results
  return results.map((r) => ({ ...r, score: (r.score - min) / range }))
}

function mergeAndRankResults(results: SearchResult[]): SearchResult[] {
  const urlMap = new Map<string, SearchResult>()

  for (const result of results) {
    const normalizedUrl = normalizeUrl(result.url)
    const existing = urlMap.get(normalizedUrl)

    if (!existing) {
      urlMap.set(normalizedUrl, result)
    } else {
      urlMap.set(normalizedUrl, {
        ...existing,
        score: Math.max(existing.score, result.score),
        content:
          existing.content.length > result.content.length ? existing.content : result.content,
      })
    }
  }

  return Array.from(urlMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    parsed.searchParams.delete("utm_source")
    parsed.searchParams.delete("utm_medium")
    parsed.searchParams.delete("utm_campaign")
    return parsed.toString().replace(/\/$/, "").toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

/**
 * Format search results for LLM context (verbose).
 */
export function formatSearchResultsForLLM(response: SearchResponse): string {
  const parts: string[] = []

  parts.push(`## Web Search Results for: "${response.query}"`)
  parts.push(`*Provider: ${response.provider} | Response time: ${response.responseTime}ms*\n`)

  if (response.answer) {
    parts.push(`### AI Summary\n${response.answer}\n`)
  }

  if (response.results.length > 0) {
    parts.push("### Search Results\n")
    response.results.forEach((result, index) => {
      parts.push(`**${index + 1}. ${result.title}**`)
      parts.push(`URL: ${result.url}`)
      if (result.publishedDate) {
        parts.push(`Published: ${result.publishedDate}`)
      }
      parts.push(`${result.content}\n`)
    })
  }

  return parts.join("\n")
}

/**
 * Format search results as compact context.
 */
export function formatSearchResultsCompact(response: SearchResponse): string {
  const parts: string[] = []

  if (response.answer) {
    parts.push(`[Answer] ${response.answer}`)
  }

  response.results.slice(0, 5).forEach((result, index) => {
    parts.push(`[${index + 1}] ${result.title}: ${result.content.slice(0, 200)}...`)
    parts.push(`    Source: ${result.url}`)
  })

  return parts.join("\n")
}
