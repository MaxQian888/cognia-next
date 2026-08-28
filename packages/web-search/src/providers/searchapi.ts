/**
 * SearchAPI.io Provider
 * Multi-engine aggregator (Google, Bing, Baidu, etc.)
 */

import type {
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchImage,
  SearchRecency,
} from "../types"
import { searchApiFetch } from "../proxy-search-fetch"
import { log } from "../log"

const SEARCHAPI_URL = "https://www.searchapi.io/api/v1/search"

export type SearchAPIEngine =
  | "google"
  | "google_news"
  | "google_images"
  | "google_videos"
  | "google_scholar"
  | "bing"
  | "bing_news"
  | "bing_images"
  | "baidu"
  | "yandex"
  | "duckduckgo"

export interface SearchAPIOptions extends Omit<SearchOptions, "safeSearch"> {
  engine?: SearchAPIEngine
  location?: string
  googleDomain?: string
  /** Accepts the unified levels and the legacy boolean adapter option. */
  safeSearch?: SearchOptions["safeSearch"] | boolean
  timeRange?: "qdr:h" | "qdr:d" | "qdr:w" | "qdr:m" | "qdr:y"
  page?: number
}

function isSafeSearchActive(safeSearch: SearchAPIOptions["safeSearch"]): boolean {
  if (safeSearch === undefined) return true
  return safeSearch !== false && safeSearch !== "off"
}

interface SearchAPIOrganicResult {
  position: number
  title: string
  link: string
  snippet: string
  date?: string
  source?: string
  favicon?: string
  thumbnail?: string
}

interface SearchAPIImageResult {
  position: number
  title: string
  link: string
  thumbnail: string
  original: string
  source?: string
  width?: number
  height?: number
}

interface SearchAPINewsResult {
  position: number
  title: string
  link: string
  snippet: string
  date?: string
  source?: string
  thumbnail?: string
}

interface SearchAPIResponse {
  search_metadata: {
    id: string
    status: string
    created_at: string
    processed_at: string
    total_time_taken: number
  }
  search_parameters: Record<string, string>
  search_information?: {
    total_results?: number
    time_taken_displayed?: number
  }
  organic_results?: SearchAPIOrganicResult[]
  image_results?: SearchAPIImageResult[]
  news_results?: SearchAPINewsResult[]
  ai_overview?: {
    text: string
    sources?: Array<{ title: string; link: string }>
  }
  answer_box?: {
    type: string
    answer?: string
    snippet?: string
    title?: string
    link?: string
  }
}

function mapRecencyToTimeRange(recency?: SearchRecency): string | undefined {
  if (!recency || recency === "any") return undefined
  const mapping: Record<SearchRecency, string> = {
    day: "qdr:d",
    week: "qdr:w",
    month: "qdr:m",
    year: "qdr:y",
    any: "",
  }
  return mapping[recency]
}

/**
 * Search using SearchAPI.io
 */
export async function searchWithSearchAPI(
  query: string,
  apiKey: string,
  options: SearchAPIOptions = {}
): Promise<SearchResponse> {
  const {
    maxResults = 10,
    engine = "google",
    country,
    language,
    recency,
    location,
    googleDomain,
    safeSearch,
    page = 1,
  } = options

  if (!apiKey) {
    throw new Error("SearchAPI API key is required")
  }

  const startTime = Date.now()

  const params = new URLSearchParams({
    engine,
    q: query,
    api_key: apiKey,
    num: maxResults.toString(),
    page: page.toString(),
  })

  if (country) params.append("gl", country)
  if (language) params.append("hl", language)
  if (location) params.append("location", location)
  if (googleDomain) params.append("google_domain", googleDomain)
  if (isSafeSearchActive(safeSearch)) params.append("safe", "active")

  const timeRange = mapRecencyToTimeRange(recency)
  if (timeRange) params.append("tbs", timeRange)

  try {
    const response = await searchApiFetch(`${SEARCHAPI_URL}?${params.toString()}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`SearchAPI error: ${response.status} - ${errorText}`)
    }

    const data: SearchAPIResponse = await response.json()

    let results: SearchResult[] = []
    let images: SearchImage[] | undefined
    let answer: string | undefined

    if (data.organic_results) {
      results = data.organic_results.map((result) => ({
        title: result.title,
        url: result.link,
        content: result.snippet,
        score: 1 - (result.position - 1) * 0.05,
        publishedDate: result.date,
        source: result.source,
        favicon: result.favicon,
        thumbnail: result.thumbnail,
      }))
    }

    if (data.news_results && engine.includes("news")) {
      results = data.news_results.map((result) => ({
        title: result.title,
        url: result.link,
        content: result.snippet,
        score: 1 - (result.position - 1) * 0.05,
        publishedDate: result.date,
        source: result.source,
        thumbnail: result.thumbnail,
      }))
    }

    if (data.image_results && engine.includes("images")) {
      images = data.image_results.map((result) => ({
        url: result.original,
        thumbnailUrl: result.thumbnail,
        title: result.title,
        width: result.width,
        height: result.height,
      }))
    }

    if (data.ai_overview?.text) {
      answer = data.ai_overview.text
    } else if (data.answer_box?.answer) {
      answer = data.answer_box.answer
    } else if (data.answer_box?.snippet) {
      answer = data.answer_box.snippet
    }

    return {
      provider: "searchapi",
      query,
      answer,
      results,
      images,
      responseTime: Date.now() - startTime,
      totalResults: data.search_information?.total_results,
    }
  } catch (error) {
    log.error("SearchAPI error", error)
    throw new Error(
      error instanceof Error
        ? `SearchAPI search failed: ${error.message}`
        : "SearchAPI search failed: Unknown error"
    )
  }
}

export async function searchNewsWithSearchAPI(
  query: string,
  apiKey: string,
  options: Omit<SearchAPIOptions, "engine"> = {}
): Promise<SearchResponse> {
  return searchWithSearchAPI(query, apiKey, { ...options, engine: "google_news" })
}

export async function searchImagesWithSearchAPI(
  query: string,
  apiKey: string,
  options: Omit<SearchAPIOptions, "engine"> = {}
): Promise<SearchResponse> {
  return searchWithSearchAPI(query, apiKey, { ...options, engine: "google_images" })
}

export async function searchScholarWithSearchAPI(
  query: string,
  apiKey: string,
  options: Omit<SearchAPIOptions, "engine"> = {}
): Promise<SearchResponse> {
  return searchWithSearchAPI(query, apiKey, { ...options, engine: "google_scholar" })
}

export async function testSearchAPIConnection(apiKey: string): Promise<boolean> {
  try {
    await searchWithSearchAPI("test", apiKey, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}
