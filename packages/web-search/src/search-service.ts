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
import { getEnabledProviders, isProviderConfigured } from "./types"
import { normalizeSearchDomain } from "./search-constants"
import { getProviderHealth } from "./provider-health"
import { log } from "./log"

import { routeSearch } from "./search-type-router"
import { buildKeyPool, pickStartIndex, recordKeyAttempt } from "./key-rotation"
import { classifySearchError, backoffDelay, sleep } from "./retry"
import { testTavilyConnection } from "./providers/tavily"
import { testPerplexityConnection } from "./providers/perplexity"
import { testExaConnection } from "./providers/exa"
import { testSearchAPIConnection } from "./providers/searchapi"
import { testSerperConnection } from "./providers/serper"
import { testSerpAPIConnection } from "./providers/serpapi"
import { testBingConnection } from "./providers/bing"
import { testGoogleConnection } from "./providers/google"
import { testGoogleAIConnection } from "./providers/google-ai"
import { testBraveConnection } from "./providers/brave"

export interface UnifiedSearchOptions extends SearchOptions {
  provider?: SearchProviderType
  /** Providers to try first, in order, before the normal priority-ordered fallback list. */
  preferredProviders?: SearchProviderType[]
  fallbackEnabled?: boolean
  providerSettings?: Partial<Record<SearchProviderType, SearchProviderSettings>>
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
  /** Abort the whole search (cancels in-flight backoff waits). */
  abortSignal?: AbortSignal
  /** Injectable RNG for deterministic tests (random rotation / jitter). */
  random?: () => number
}

/** Default extra attempts per provider before falling through to the next one. */
const DEFAULT_MAX_RETRIES = 2

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
    fallbackEnabled = true,
    providerSettings,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryBackoffMs,
    abortSignal,
    random,
    ...searchOptions
  } = options

  if (!providerSettings) {
    throw new Error("Provider settings are required")
  }

  const retry: ProviderRetryConfig = { maxRetries, retryBackoffMs, abortSignal, random }

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

  // Circuit breaker: try healthy providers first, pushing still-open (recently
  // failing) providers to the back so a hard-down provider doesn't cost a
  // round-trip on every query. Identity when the breaker is disabled.
  const health = getProviderHealth()
  providersToTry = health.orderByHealth(providersToTry)

  let lastError: Error | null = null
  let lastDomainFilteredResponse: SearchResponse | null = null

  for (const providerConfig of providersToTry) {
    const startTime = Date.now()
    try {
      const result = await attemptProviderWithRotation(query, providerConfig, searchOptions, retry)
      health.recordResult(providerConfig.providerId, true)
      void recordUsage(providerConfig.providerId, Date.now() - startTime, true)
      const filteredResult = filterResponseByIncludedDomains(result, searchOptions.includeDomains)
      if (filteredResult.results.length > 0 || !hasDomainConstraint(searchOptions.includeDomains)) {
        return filteredResult
      }
      lastDomainFilteredResponse = filteredResult
      if (!fallbackEnabled) return filteredResult
    } catch (error) {
      // A caller-driven abort is not a provider failure — surface it immediately
      // instead of silently trying the next provider.
      if (isAbortError(error)) throw error
      log.warn(`Search with ${providerConfig.providerId} failed`, { error })
      lastError = error instanceof Error ? error : new Error(String(error))
      health.recordResult(providerConfig.providerId, false)
      void recordUsage(providerConfig.providerId, Date.now() - startTime, false)

      if (!fallbackEnabled) {
        break
      }
    }
  }

  if (lastDomainFilteredResponse) return lastDomainFilteredResponse
  throw lastError || new Error("All search providers failed")
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

function filterResponseByIncludedDomains(
  response: SearchResponse,
  includeDomains: string[] | undefined
): SearchResponse {
  if (!hasDomainConstraint(includeDomains)) return response

  const domains = includeDomains ?? []
  const results = response.results.filter((result) =>
    urlMatchesIncludedDomains(result.url, domains)
  )
  const images = response.images?.filter((image) => urlMatchesIncludedDomains(image.url, domains))

  return {
    ...response,
    // The provider synthesized `answer` from the unfiltered result set, so it
    // can cite pages this filter just removed. Keep it only when the filter
    // removed nothing; a partially-filtered answer is grounded in sources the
    // caller's domain policy excluded and has no matching citation left.
    answer: results.length === response.results.length ? response.answer : undefined,
    results,
    images: images && images.length > 0 ? images : undefined,
    totalResults: results.length,
  }
}

interface ProviderRetryConfig {
  maxRetries: number
  retryBackoffMs?: number
  abortSignal?: AbortSignal
  random?: () => number
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /(?:^|\b)abort(?:ed)?\b/i.test(error.message))
  )
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
      const classification = classifySearchError(error)
      const hasAttemptsLeft = attempt < maxAttempts - 1
      if (!classification.retryable || !hasAttemptsLeft) {
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
        return await testBingConnection(apiKey)
      case "google":
        if (!providerSettings?.cx || providerSettings.cx.trim() === "") {
          return false
        }
        return await testGoogleConnection(apiKey, providerSettings.cx)
      case "google-ai":
        return await testGoogleAIConnection(apiKey)
      case "brave":
        return await testBraveConnection(apiKey)
      default:
        return false
    }
  } catch {
    return false
  }
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
