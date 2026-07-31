/**
 * Perplexity Search Provider
 * High-quality search with recency and geo filters
 */

import type { SearchOptions, SearchResponse, SearchResult, SearchRecency } from "../types"
import { perplexityFetch } from "../proxy-search-fetch"
import { log } from "../log"

const PERPLEXITY_API_URL = "https://api.perplexity.ai/search"

export interface PerplexitySearchOptions extends SearchOptions {
  searchDomainFilter?: string[]
  maxTokens?: number
  maxTokensPerPage?: number
  searchAfterDate?: string
  searchBeforeDate?: string
}

interface PerplexityResult {
  title: string
  url: string
  snippet: string
  date?: string
  last_updated?: string
}

interface PerplexityResponse {
  results: PerplexityResult[]
}

function mapRecencyToPerplexity(recency?: SearchRecency): string | undefined {
  if (!recency || recency === "any") return undefined
  return recency
}

/**
 * Search the web using Perplexity API
 */
export async function searchWithPerplexity(
  query: string,
  apiKey: string,
  options: PerplexitySearchOptions = {}
): Promise<SearchResponse> {
  const {
    maxResults = 10,
    includeDomains,
    excludeDomains,
    recency,
    country,
    language,
    maxTokens = 25000,
    maxTokensPerPage = 1024,
    searchAfterDate,
    searchBeforeDate,
  } = options

  if (!apiKey) {
    throw new Error("Perplexity API key is required")
  }

  const startTime = Date.now()

  const requestBody: Record<string, unknown> = {
    query,
    max_results: Math.min(maxResults, 20),
    max_tokens: maxTokens,
    max_tokens_per_page: maxTokensPerPage,
  }

  if (includeDomains && includeDomains.length > 0 && excludeDomains && excludeDomains.length > 0) {
    throw new Error("Perplexity does not support mixing includeDomains and excludeDomains")
  }

  if (includeDomains && includeDomains.length > 0) {
    requestBody.search_domain_filter = includeDomains.slice(0, 20)
  } else if (excludeDomains && excludeDomains.length > 0) {
    requestBody.search_domain_filter = excludeDomains
      .slice(0, 20)
      .map((domain) => (domain.startsWith("-") ? domain : `-${domain}`))
  }

  if (country) {
    requestBody.country = country
  }

  if (language) {
    requestBody.search_language_filter = [language]
  }

  const perplexityRecency = mapRecencyToPerplexity(recency)
  if (perplexityRecency) {
    requestBody.search_recency_filter = perplexityRecency
  }

  if (searchAfterDate) {
    requestBody.search_after_date_filter = searchAfterDate
  }

  if (searchBeforeDate) {
    requestBody.search_before_date_filter = searchBeforeDate
  }

  try {
    const response = await perplexityFetch(PERPLEXITY_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Perplexity API error: ${response.status} - ${errorText}`)
    }

    const data: PerplexityResponse = await response.json()

    const results: SearchResult[] = data.results.map((result, index) => ({
      title: result.title,
      url: result.url,
      content: result.snippet,
      score: 1 - index * 0.05,
      publishedDate: result.date || result.last_updated,
    }))

    return {
      provider: "perplexity",
      query,
      results,
      responseTime: Date.now() - startTime,
      totalResults: results.length,
    }
  } catch (error) {
    log.error("Perplexity search error", error)
    throw new Error(
      error instanceof Error
        ? `Perplexity search failed: ${error.message}`
        : "Perplexity search failed: Unknown error"
    )
  }
}

/**
 * Test Perplexity API connection
 */
export async function testPerplexityConnection(apiKey: string): Promise<boolean> {
  try {
    await searchWithPerplexity("test", apiKey, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}
