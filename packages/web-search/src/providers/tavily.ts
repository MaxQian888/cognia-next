/**
 * Tavily Search Provider
 * AI-optimized search engine with answer generation.
 *
 * Note: this implementation hits Tavily's REST API directly (no SDK
 * dependency) because cognia-next doesn't pull `@tavily/core`. Same
 * functional surface as Cognia's port.
 */

import type { SearchOptions, SearchResponse, SearchResult } from "../types"
import { tavilyFetch } from "../proxy-search-fetch"
import { log } from "../log"

const TAVILY_SEARCH_URL = "https://api.tavily.com/search"
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract"

export interface TavilySearchOptions extends Omit<SearchOptions, "includeRawContent"> {
  includeRawContent?: false | "text" | "markdown"
}

interface TavilyApiResult {
  title: string
  url: string
  content: string
  score: number
  published_date?: string
  raw_content?: string
}

interface TavilyApiResponse {
  query: string
  answer?: string
  results: TavilyApiResult[]
  response_time?: number
}

interface TavilyExtractResult {
  url: string
  raw_content?: string
}

interface TavilyExtractResponse {
  results: TavilyExtractResult[]
}

/**
 * Search the web using Tavily API
 */
export async function searchWithTavily(
  query: string,
  apiKey: string,
  options: TavilySearchOptions = {}
): Promise<SearchResponse> {
  const {
    maxResults = 5,
    searchDepth = "basic",
    includeAnswer = true,
    includeRawContent = false,
    includeDomains,
    excludeDomains,
  } = options

  if (!apiKey) {
    throw new Error("Tavily API key is required")
  }

  const startTime = Date.now()

  const requestBody: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: maxResults,
    search_depth: searchDepth === "deep" ? "advanced" : searchDepth,
    include_answer: includeAnswer,
    include_raw_content: includeRawContent,
  }
  if (includeDomains?.length) requestBody.include_domains = includeDomains
  if (excludeDomains?.length) requestBody.exclude_domains = excludeDomains

  try {
    const response = await tavilyFetch(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new Error(`Tavily API error: ${response.status} - ${errorText}`)
    }

    const data: TavilyApiResponse = await response.json()

    const results: SearchResult[] = (data.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content,
      score: result.score,
      publishedDate: result.published_date,
    }))

    return {
      provider: "tavily",
      query,
      answer: data.answer,
      results,
      responseTime: Date.now() - startTime,
    }
  } catch (error) {
    log.error("Tavily search error", error)
    throw new Error(
      error instanceof Error
        ? `Tavily search failed: ${error.message}`
        : "Tavily search failed: Unknown error"
    )
  }
}

/**
 * Get a quick answer from Tavily
 */
export async function getAnswerFromTavily(query: string, apiKey: string): Promise<string | null> {
  const response = await searchWithTavily(query, apiKey, {
    maxResults: 3,
    searchDepth: "basic",
    includeAnswer: true,
  })
  return response.answer || null
}

/**
 * Extract content from a URL using Tavily
 */
export async function extractContentWithTavily(url: string, apiKey: string): Promise<string> {
  if (!apiKey) {
    throw new Error("Tavily API key is required")
  }

  try {
    const response = await tavilyFetch(TAVILY_EXTRACT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, urls: [url] }),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new Error(`Tavily extract API error: ${response.status} - ${errorText}`)
    }

    const data: TavilyExtractResponse = await response.json()
    return data.results?.[0]?.raw_content ?? ""
  } catch (error) {
    log.error("Tavily extract error", error)
    throw new Error(
      error instanceof Error
        ? `Tavily extract failed: ${error.message}`
        : "Tavily extract failed: Unknown error"
    )
  }
}

/**
 * Test Tavily API connection
 */
export async function testTavilyConnection(apiKey: string): Promise<boolean> {
  try {
    await searchWithTavily("test", apiKey, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}
