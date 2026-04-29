/**
 * Serper Search Provider
 * Lightweight Google Search API via serper.dev (google.serper.dev)
 */

import type {
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchImage,
  SearchRecency,
} from "@/lib/search/types"
import { serperFetch } from "../proxy-search-fetch"
import { log } from "../log"

const SERPER_BASE_URL = "https://google.serper.dev"

export interface SerperSearchOptions extends SearchOptions {
  /** Serper supports up to 100 results per query (provider-side limits may apply) */
  maxResults?: number
}

interface SerperOrganicResult {
  title: string
  link: string
  snippet?: string
  position?: number
  date?: string
  source?: string
  favicon?: string
  imageUrl?: string
}

interface SerperNewsResult {
  title: string
  link: string
  snippet?: string
  date?: string
  source?: string
  imageUrl?: string
  position?: number
}

interface SerperImageResult {
  imageUrl: string
  thumbnailUrl?: string
  title?: string
  imageWidth?: number
  imageHeight?: number
  position?: number
}

interface SerperVideoResult {
  title: string
  link: string
  snippet?: string
  imageUrl?: string
  date?: string
  source?: string
  position?: number
}

interface SerperAnswerBox {
  answer?: string
  snippet?: string
  title?: string
  link?: string
}

interface SerperKnowledgeGraph {
  title?: string
  description?: string
  type?: string
}

interface SerperSearchResponse {
  organic?: SerperOrganicResult[]
  news?: SerperNewsResult[]
  images?: SerperImageResult[]
  videos?: SerperVideoResult[]
  answerBox?: SerperAnswerBox
  knowledgeGraph?: SerperKnowledgeGraph
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

function extractAnswer(data: SerperSearchResponse): string | undefined {
  if (data.answerBox?.answer) return data.answerBox.answer
  if (data.answerBox?.snippet) return data.answerBox.snippet
  if (data.knowledgeGraph?.description) return data.knowledgeGraph.description
  return undefined
}

async function requestSerper(
  path: "/search" | "/news" | "/images" | "/videos" | "/scholar",
  query: string,
  apiKey: string,
  options: SerperSearchOptions
): Promise<SerperSearchResponse> {
  if (!apiKey) {
    throw new Error("Serper API key is required")
  }

  const { maxResults = 10, country, language, recency } = options

  const requestBody: Record<string, unknown> = {
    q: query,
    num: Math.min(Math.max(1, maxResults), 100),
  }

  if (country) requestBody.gl = country
  if (language) requestBody.hl = language

  const tbs = mapRecencyToTbs(recency)
  if (tbs) requestBody.tbs = tbs

  const response = await serperFetch(`${SERPER_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => "")
    throw new Error(`Serper API error: ${response.status} - ${errorText}`)
  }

  return (await response.json()) as SerperSearchResponse
}

function organicToResults(organic?: SerperOrganicResult[]): SearchResult[] {
  if (!organic || organic.length === 0) return []

  return organic.map((result, index) => {
    const position = typeof result.position === "number" ? result.position : index + 1
    return {
      title: result.title,
      url: result.link,
      content: result.snippet || "",
      score: Math.max(0, 1 - (position - 1) * 0.05),
      publishedDate: result.date,
      source: result.source,
      favicon: result.favicon,
      thumbnail: result.imageUrl,
    }
  })
}

export async function searchWithSerper(
  query: string,
  apiKey: string,
  options: SerperSearchOptions = {}
): Promise<SearchResponse> {
  const startTime = Date.now()

  try {
    const data = await requestSerper("/search", query, apiKey, options)
    const results = organicToResults(data.organic)
    const answer = extractAnswer(data)

    return {
      provider: "serper",
      query,
      answer,
      results,
      responseTime: Date.now() - startTime,
      totalResults: results.length,
    }
  } catch (error) {
    log.error("Serper search error", error)
    throw new Error(
      error instanceof Error
        ? `Serper search failed: ${error.message}`
        : "Serper search failed: Unknown error"
    )
  }
}

export async function searchNewsWithSerper(
  query: string,
  apiKey: string,
  options: SerperSearchOptions = {}
): Promise<SearchResponse> {
  const startTime = Date.now()

  try {
    const data = await requestSerper("/news", query, apiKey, options)
    const news = data.news || []

    const results: SearchResult[] = news.map((result, index) => {
      const position = typeof result.position === "number" ? result.position : index + 1
      return {
        title: result.title,
        url: result.link,
        content: result.snippet || "",
        score: Math.max(0, 1 - (position - 1) * 0.05),
        publishedDate: result.date,
        source: result.source,
        thumbnail: result.imageUrl,
      }
    })

    return {
      provider: "serper",
      query,
      results,
      responseTime: Date.now() - startTime,
      totalResults: results.length,
    }
  } catch (error) {
    log.error("Serper news search error", error)
    throw new Error(
      error instanceof Error
        ? `Serper news search failed: ${error.message}`
        : "Serper news search failed: Unknown error"
    )
  }
}

export async function searchImagesWithSerper(
  query: string,
  apiKey: string,
  options: SerperSearchOptions = {}
): Promise<SearchResponse> {
  const startTime = Date.now()

  try {
    const data = await requestSerper("/images", query, apiKey, options)
    const imagesData = data.images || []

    const images: SearchImage[] = imagesData
      .filter((img) => typeof img.imageUrl === "string" && img.imageUrl.length > 0)
      .map((img) => ({
        url: img.imageUrl,
        thumbnailUrl: img.thumbnailUrl,
        title: img.title,
        width: img.imageWidth,
        height: img.imageHeight,
      }))

    return {
      provider: "serper",
      query,
      results: [],
      images,
      responseTime: Date.now() - startTime,
      totalResults: images.length,
    }
  } catch (error) {
    log.error("Serper image search error", error)
    throw new Error(
      error instanceof Error
        ? `Serper image search failed: ${error.message}`
        : "Serper image search failed: Unknown error"
    )
  }
}

export async function searchVideosWithSerper(
  query: string,
  apiKey: string,
  options: SerperSearchOptions = {}
): Promise<SearchResponse> {
  const startTime = Date.now()

  try {
    const data = await requestSerper("/videos", query, apiKey, options)
    const videos = data.videos || []

    const results: SearchResult[] = videos.map((result, index) => {
      const position = typeof result.position === "number" ? result.position : index + 1
      return {
        title: result.title,
        url: result.link,
        content: result.snippet || "",
        score: Math.max(0, 1 - (position - 1) * 0.05),
        publishedDate: result.date,
        source: result.source,
        thumbnail: result.imageUrl,
      }
    })

    return {
      provider: "serper",
      query,
      results,
      responseTime: Date.now() - startTime,
      totalResults: results.length,
    }
  } catch (error) {
    log.error("Serper video search error", error)
    throw new Error(
      error instanceof Error
        ? `Serper video search failed: ${error.message}`
        : "Serper video search failed: Unknown error"
    )
  }
}

export async function searchScholarWithSerper(
  query: string,
  apiKey: string,
  options: SerperSearchOptions = {}
): Promise<SearchResponse> {
  const startTime = Date.now()

  try {
    const data = await requestSerper("/scholar", query, apiKey, options)
    const results = organicToResults(data.organic)
    const answer = extractAnswer(data)

    return {
      provider: "serper",
      query,
      answer,
      results,
      responseTime: Date.now() - startTime,
      totalResults: results.length,
    }
  } catch (error) {
    log.error("Serper scholar search error", error)
    throw new Error(
      error instanceof Error
        ? `Serper scholar search failed: ${error.message}`
        : "Serper scholar search failed: Unknown error"
    )
  }
}

export async function testSerperConnection(apiKey: string): Promise<boolean> {
  try {
    await searchWithSerper("test", apiKey, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}
