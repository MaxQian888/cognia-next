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
} from "@/lib/search/types"
import { getEnabledProviders, isProviderConfigured } from "@/lib/search/types"
import { log } from "./log"

import { routeSearch } from "./search-type-router"
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
  fallbackEnabled?: boolean
  providerSettings?: Partial<Record<SearchProviderType, SearchProviderSettings>>
}

/**
 * Unified search function. Searches using the specified provider or falls
 * back to alternatives. Increments per-provider usage stats via the
 * settings store on every attempt (success or failure).
 */
export async function search(
  query: string,
  options: UnifiedSearchOptions = {}
): Promise<SearchResponse> {
  const { provider, fallbackEnabled = true, providerSettings, ...searchOptions } = options

  if (!providerSettings) {
    throw new Error("Provider settings are required")
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
    providersToTry = fallbackEnabled
      ? [specificProvider, ...enabledProviders.filter((p) => p.providerId !== provider)]
      : [specificProvider]
  } else {
    providersToTry = enabledProviders
  }

  let lastError: Error | null = null

  for (const providerConfig of providersToTry) {
    const startTime = Date.now()
    try {
      const result = await routeSearch(
        query,
        providerConfig.providerId,
        providerConfig,
        searchOptions
      )
      void recordUsage(providerConfig.providerId, Date.now() - startTime, true)
      return result
    } catch (error) {
      log.warn(`Search with ${providerConfig.providerId} failed`, { error })
      lastError = error instanceof Error ? error : new Error(String(error))
      void recordUsage(providerConfig.providerId, Date.now() - startTime, false)

      if (!fallbackEnabled) {
        break
      }
    }
  }

  throw lastError || new Error("All search providers failed")
}

/**
 * Best-effort usage reporting: tries to call the settings store's
 * `incrementSearchUsage` action if it exists. Imported lazily to avoid a
 * cyclic dep at module-load time.
 */
async function recordUsage(
  providerId: SearchProviderType,
  responseTime: number,
  success: boolean
): Promise<void> {
  try {
    const mod = await import("@/stores/settings-store")
    const fn = (
      mod.useSettingsStore.getState() as {
        incrementSearchUsage?: (id: SearchProviderType, ms: number, ok: boolean) => void
      }
    ).incrementSearchUsage
    if (typeof fn === "function") {
      fn(providerId, responseTime, success)
    }
  } catch {
    // Store may not be initialized in non-browser contexts (tests, SSR);
    // ignore — usage stats are best-effort.
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

  const aggregatedResults = mergeAndRankResults(successfulResults.flatMap((r) => r.results))

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
