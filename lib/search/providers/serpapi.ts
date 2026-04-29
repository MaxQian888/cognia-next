/**
 * SerpAPI Provider
 * Google search results API with rich features
 */

import type {
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchImage,
  SearchRecency,
} from "@/lib/search/types"
import { serpApiFetch } from "../proxy-search-fetch"
import { log } from "../log"

const SERPAPI_URL = "https://serpapi.com/search.json"

export type SerpAPIEngine = "google" | "bing" | "yahoo" | "yandex" | "baidu" | "duckduckgo"

export interface SerpAPIOptions extends SearchOptions {
  engine?: SerpAPIEngine
  location?: string
  googleDomain?: string
  safeSearch?: "active" | "off"
  tbm?: "nws" | "isch" | "vid" | "bks" | "shop"
  start?: number
}

interface SerpAPIOrganicResult {
  position: number
  title: string
  link: string
  snippet: string
  date?: string
  source?: string
  favicon?: string
  thumbnail?: string
}

interface SerpAPIImageResult {
  position: number
  title: string
  link: string
  thumbnail: string
  original: string
  source?: string
}

interface SerpAPINewsResult {
  position: number
  title: string
  link: string
  snippet: string
  date?: string
  source?: string
  thumbnail?: string
}

interface SerpAPIResponse {
  search_metadata: {
    id: string
    status: string
    json_endpoint: string
    created_at: string
    processed_at: string
    total_time_taken: number
  }
  search_parameters: Record<string, string>
  search_information?: {
    total_results?: number
    time_taken_displayed?: number
    organic_results_state?: string
  }
  organic_results?: SerpAPIOrganicResult[]
  images_results?: SerpAPIImageResult[]
  news_results?: SerpAPINewsResult[]
  answer_box?: {
    type: string
    answer?: string
    snippet?: string
    snippet_highlighted_words?: string[]
    title?: string
    link?: string
  }
  knowledge_graph?: {
    title?: string
    description?: string
    source?: { name: string; link: string }
  }
}

function mapRecencyToTbs(recency?: SearchRecency): string | undefined {
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

export async function searchWithSerpAPI(
  query: string,
  apiKey: string,
  options: SerpAPIOptions = {}
): Promise<SearchResponse> {
  const {
    maxResults = 10,
    engine = "google",
    country,
    language,
    recency,
    location,
    googleDomain = "google.com",
    safeSearch = "active",
    tbm,
    start = 0,
  } = options

  if (!apiKey) {
    throw new Error("SerpAPI API key is required")
  }

  const startTime = Date.now()

  const params = new URLSearchParams({
    engine,
    q: query,
    api_key: apiKey,
    num: maxResults.toString(),
    start: start.toString(),
    safe: safeSearch,
  })

  if (country) params.append("gl", country)
  if (language) params.append("hl", language)
  if (location) params.append("location", location)
  if (engine === "google" && googleDomain) params.append("google_domain", googleDomain)
  if (tbm) params.append("tbm", tbm)

  const tbs = mapRecencyToTbs(recency)
  if (tbs) params.append("tbs", tbs)

  try {
    const response = await serpApiFetch(`${SERPAPI_URL}?${params.toString()}`, {
      method: "GET",
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`SerpAPI error: ${response.status} - ${errorText}`)
    }

    const data: SerpAPIResponse = await response.json()

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

    if (data.news_results) {
      const newsResults = data.news_results.map((result) => ({
        title: result.title,
        url: result.link,
        content: result.snippet,
        score: 1 - (result.position - 1) * 0.05,
        publishedDate: result.date,
        source: result.source,
        thumbnail: result.thumbnail,
      }))
      results = [...results, ...newsResults]
    }

    if (data.images_results) {
      images = data.images_results.map((result) => ({
        url: result.original,
        thumbnailUrl: result.thumbnail,
        title: result.title,
      }))
    }

    if (data.answer_box?.answer) {
      answer = data.answer_box.answer
    } else if (data.answer_box?.snippet) {
      answer = data.answer_box.snippet
    } else if (data.knowledge_graph?.description) {
      answer = data.knowledge_graph.description
    }

    return {
      provider: "serpapi",
      query,
      answer,
      results,
      images,
      responseTime: Date.now() - startTime,
      totalResults: data.search_information?.total_results,
    }
  } catch (error) {
    log.error("SerpAPI error", error)
    throw new Error(
      error instanceof Error
        ? `SerpAPI search failed: ${error.message}`
        : "SerpAPI search failed: Unknown error"
    )
  }
}

export async function searchNewsWithSerpAPI(
  query: string,
  apiKey: string,
  options: Omit<SerpAPIOptions, "tbm"> = {}
): Promise<SearchResponse> {
  return searchWithSerpAPI(query, apiKey, { ...options, tbm: "nws" })
}

export async function searchImagesWithSerpAPI(
  query: string,
  apiKey: string,
  options: Omit<SerpAPIOptions, "tbm"> = {}
): Promise<SearchResponse> {
  return searchWithSerpAPI(query, apiKey, { ...options, tbm: "isch" })
}

export async function testSerpAPIConnection(apiKey: string): Promise<boolean> {
  try {
    await searchWithSerpAPI("test", apiKey, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}
