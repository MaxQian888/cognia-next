/**
 * Exa Search Provider
 * Neural search engine with semantic understanding
 */

import type { SearchOptions, SearchResponse, SearchResult } from "@/lib/search/types"
import { exaFetch } from "../proxy-search-fetch"
import { log } from "../log"

const EXA_API_URL = "https://api.exa.ai/search"

export interface ExaSearchOptions extends SearchOptions {
  type?: "neural" | "keyword" | "auto"
  useAutoprompt?: boolean
  category?: string
  includeText?: string[]
  excludeText?: string[]
  startPublishedDate?: string
  endPublishedDate?: string
  startCrawlDate?: string
  endCrawlDate?: string
  contents?: {
    text?: boolean | { maxCharacters?: number; includeHtmlTags?: boolean }
    highlights?: boolean | { numSentences?: number; highlightsPerUrl?: number }
    summary?: boolean | { query?: string }
  }
}

interface ExaResult {
  title: string
  url: string
  id: string
  score?: number
  publishedDate?: string
  author?: string
  text?: string
  highlights?: string[]
  summary?: string
}

interface ExaResponse {
  requestId: string
  resolvedSearchType: string
  results: ExaResult[]
  autopromptString?: string
}

/**
 * Search the web using Exa API
 */
export async function searchWithExa(
  query: string,
  apiKey: string,
  options: ExaSearchOptions = {}
): Promise<SearchResponse> {
  const {
    maxResults = 10,
    type = "auto",
    useAutoprompt = true,
    includeDomains,
    excludeDomains,
    includeText,
    excludeText,
    startPublishedDate,
    endPublishedDate,
    contents,
  } = options

  if (!apiKey) {
    throw new Error("Exa API key is required")
  }

  const startTime = Date.now()

  const requestBody: Record<string, unknown> = {
    query,
    type,
    numResults: maxResults,
    useAutoprompt,
  }

  if (includeDomains && includeDomains.length > 0) requestBody.includeDomains = includeDomains
  if (excludeDomains && excludeDomains.length > 0) requestBody.excludeDomains = excludeDomains
  if (includeText && includeText.length > 0) requestBody.includeText = includeText
  if (excludeText && excludeText.length > 0) requestBody.excludeText = excludeText
  if (startPublishedDate) requestBody.startPublishedDate = startPublishedDate
  if (endPublishedDate) requestBody.endPublishedDate = endPublishedDate
  if (contents) requestBody.contents = contents

  try {
    const response = await exaFetch(EXA_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Exa API error: ${response.status} - ${errorText}`)
    }

    const data: ExaResponse = await response.json()

    const results: SearchResult[] = data.results.map((result) => {
      let content = result.text || ""
      if (result.highlights && result.highlights.length > 0) {
        content = result.highlights.join(" ... ")
      }
      if (result.summary) {
        content = result.summary
      }

      return {
        title: result.title,
        url: result.url,
        content,
        score: result.score || 0,
        publishedDate: result.publishedDate,
        source: result.author,
      }
    })

    return {
      provider: "exa",
      query,
      results,
      responseTime: Date.now() - startTime,
      totalResults: results.length,
    }
  } catch (error) {
    log.error("Exa search error", error)
    throw new Error(
      error instanceof Error
        ? `Exa search failed: ${error.message}`
        : "Exa search failed: Unknown error"
    )
  }
}

/**
 * Find similar links using Exa
 */
export async function findSimilarWithExa(
  url: string,
  apiKey: string,
  options: Omit<ExaSearchOptions, "type"> = {}
): Promise<SearchResponse> {
  const { maxResults = 10, includeDomains, excludeDomains } = options

  if (!apiKey) {
    throw new Error("Exa API key is required")
  }

  const startTime = Date.now()

  const requestBody: Record<string, unknown> = {
    url,
    numResults: maxResults,
  }

  if (includeDomains && includeDomains.length > 0) requestBody.includeDomains = includeDomains
  if (excludeDomains && excludeDomains.length > 0) requestBody.excludeDomains = excludeDomains

  try {
    const response = await exaFetch("https://api.exa.ai/findSimilar", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Exa API error: ${response.status} - ${errorText}`)
    }

    const data: ExaResponse = await response.json()

    const results: SearchResult[] = data.results.map((result) => ({
      title: result.title,
      url: result.url,
      content: result.text || "",
      score: result.score || 0,
      publishedDate: result.publishedDate,
    }))

    return {
      provider: "exa",
      query: `Similar to: ${url}`,
      results,
      responseTime: Date.now() - startTime,
    }
  } catch (error) {
    log.error("Exa findSimilar error", error)
    throw new Error(
      error instanceof Error
        ? `Exa findSimilar failed: ${error.message}`
        : "Exa findSimilar failed: Unknown error"
    )
  }
}

/**
 * Get contents from URLs using Exa
 */
export async function getContentsWithExa(
  urls: string[],
  apiKey: string,
  options?: {
    text?: boolean | { maxCharacters?: number }
    highlights?: boolean | { numSentences?: number }
    summary?: boolean
  }
): Promise<SearchResult[]> {
  if (!apiKey) {
    throw new Error("Exa API key is required")
  }

  const requestBody: Record<string, unknown> = { urls }
  if (options) requestBody.contents = options

  try {
    const response = await exaFetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Exa API error: ${response.status} - ${errorText}`)
    }

    const data: ExaResponse = await response.json()

    return data.results.map((result) => ({
      title: result.title,
      url: result.url,
      content: result.text || result.summary || "",
      score: result.score || 0,
      publishedDate: result.publishedDate,
    }))
  } catch (error) {
    log.error("Exa getContents error", error)
    throw new Error(
      error instanceof Error
        ? `Exa getContents failed: ${error.message}`
        : "Exa getContents failed: Unknown error"
    )
  }
}

/**
 * Test Exa API connection
 */
export async function testExaConnection(apiKey: string): Promise<boolean> {
  try {
    await searchWithExa("test", apiKey, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}
