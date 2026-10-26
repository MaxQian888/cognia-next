/**
 * Tavily Search Provider
 * AI-optimized search engine with answer generation.
 *
 * Note: this implementation hits Tavily's REST API directly (no SDK
 * dependency) because cognia-next doesn't pull `@tavily/core`. Same
 * functional surface as Cognia's port.
 *
 * Auth is the documented `Authorization: Bearer` header
 * (https://docs.tavily.com, checked 2026-10-19), not the legacy `api_key`
 * body field, so the key never rides inside a JSON body a proxy might log.
 */

import type {
  SearchImage,
  SearchOptions,
  SearchRecency,
  SearchResponse,
  SearchResult,
} from "../types"
import { ProviderHttpError, readErrorDetail, tavilyFetch } from "../proxy-search-fetch"
import { log } from "../log"

const TAVILY_SEARCH_URL = "https://api.tavily.com/search"
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract"

export interface TavilySearchOptions extends Omit<SearchOptions, "includeRawContent"> {
  includeRawContent?: false | "text" | "markdown"
  /** Tavily's vertical: `news` searches news sources. */
  topic?: "general" | "news"
}

interface TavilyApiResult {
  title: string
  url: string
  content: string
  score: number
  published_date?: string
  raw_content?: string | null
}

interface TavilyApiResponse {
  query: string
  answer?: string
  results: TavilyApiResult[]
  images?: Array<string | { url: string; description?: string }>
  response_time?: number
}

interface TavilyExtractResult {
  url: string
  raw_content?: string
  images?: string[]
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[]
  failed_results?: Array<{ url: string; error: string }>
}

const TIME_RANGE: Partial<Record<SearchRecency, string>> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
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
    recency,
    safeSearch,
    topic = "general",
  } = options

  if (!apiKey) {
    throw new Error("Tavily API key is required")
  }

  const startTime = Date.now()

  const requestBody: Record<string, unknown> = {
    query,
    topic,
    max_results: maxResults,
    search_depth: searchDepth === "deep" ? "advanced" : searchDepth,
    include_answer: includeAnswer,
    include_raw_content: includeRawContent,
  }
  if (includeDomains?.length) requestBody.include_domains = includeDomains
  if (excludeDomains?.length) requestBody.exclude_domains = excludeDomains
  const timeRange = recency ? TIME_RANGE[recency] : undefined
  if (timeRange) requestBody.time_range = timeRange
  // `safe_search` is a boolean filter; moderate and strict both turn it on.
  if (safeSearch) requestBody.safe_search = safeSearch !== "off"

  try {
    const response = await tavilyFetch(TAVILY_SEARCH_URL, {
      method: "POST",
      signal: options.signal,
      headers: authHeaders(apiKey),
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const { detail, code } = await readErrorDetail(response)
      throw new ProviderHttpError("Tavily", response.status, detail, code)
    }

    const data: TavilyApiResponse = await response.json()

    const results: SearchResult[] = (data.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content,
      score: result.score,
      publishedDate: result.published_date,
      ...(includeRawContent && typeof result.raw_content === "string" && result.raw_content
        ? { rawContent: result.raw_content }
        : {}),
    }))
    const images: SearchImage[] = (data.images ?? [])
      .map((image) =>
        typeof image === "string"
          ? { url: image }
          : { url: image.url, ...(image.description ? { title: image.description } : {}) }
      )
      .filter((image) => typeof image.url === "string" && image.url !== "")

    return {
      provider: "tavily",
      query,
      answer: data.answer,
      results,
      ...(images.length > 0 ? { images } : {}),
      responseTime: Date.now() - startTime,
    }
  } catch (error) {
    log.error("Tavily search error", error)
    if (error instanceof ProviderHttpError) throw error
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

export type TavilyExtractOutcome =
  { ok: true; markdown: string; images?: string[] } | { ok: false; error: string }

/**
 * Read exactly one URL through Tavily Extract as Markdown. A per-URL failure
 * (`failed_results`, or an empty `results` under HTTP 200) returns
 * `{ ok: false }`; a request-level failure throws {@link ProviderHttpError}.
 */
export async function extractWithTavily(
  url: string,
  apiKey: string,
  options: { signal?: AbortSignal; timeoutSeconds?: number } = {}
): Promise<TavilyExtractOutcome> {
  if (!apiKey) throw new Error("Tavily API key is required")
  const body: Record<string, unknown> = { urls: [url], format: "markdown", extract_depth: "basic" }
  if (options.timeoutSeconds) {
    body.timeout = Math.min(60, Math.max(1, Math.floor(options.timeoutSeconds)))
  }
  const response = await tavilyFetch(TAVILY_EXTRACT_URL, {
    method: "POST",
    signal: options.signal,
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const { detail, code } = await readErrorDetail(response)
    throw new ProviderHttpError("Tavily", response.status, detail, code)
  }
  const data: TavilyExtractResponse = await response.json()
  const failed = data.failed_results?.[0]
  if (failed) return { ok: false, error: failed.error || "extract failed" }
  const result = data.results?.[0]
  if (!result?.raw_content?.trim()) return { ok: false, error: "empty_content" }
  return {
    ok: true,
    markdown: result.raw_content,
    ...(result.images?.length ? { images: result.images } : {}),
  }
}

/**
 * Extract content from a URL using Tavily. Legacy string-returning helper;
 * prefer {@link extractWithTavily}, which distinguishes a per-URL failure from
 * empty content.
 */
export async function extractContentWithTavily(url: string, apiKey: string): Promise<string> {
  try {
    const outcome = await extractWithTavily(url, apiKey)
    return outcome.ok ? outcome.markdown : ""
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
