/**
 * Bing Search Provider
 * Microsoft Bing Web Search API
 */

import type {
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchImage,
  SearchRecency,
} from "../types"
import { bingFetch } from "../proxy-search-fetch"
import { log } from "../log"

const BING_WEB_SEARCH_URL = "https://api.bing.microsoft.com/v7.0/search"
const BING_NEWS_SEARCH_URL = "https://api.bing.microsoft.com/v7.0/news/search"
const BING_IMAGE_SEARCH_URL = "https://api.bing.microsoft.com/v7.0/images/search"

export interface BingSearchOptions extends SearchOptions {
  safeSearch?: "Off" | "Moderate" | "Strict"
  textDecorations?: boolean
  textFormat?: "Raw" | "HTML"
  responseFilter?: ("Webpages" | "Images" | "Videos" | "News" | "RelatedSearches")[]
}

interface BingWebPage {
  id: string
  name: string
  url: string
  snippet: string
  dateLastCrawled?: string
  displayUrl?: string
  thumbnailUrl?: string
}

interface BingNewsArticle {
  name: string
  url: string
  description: string
  datePublished?: string
  provider?: Array<{ name: string }>
  image?: {
    thumbnail?: { contentUrl: string; width?: number; height?: number }
  }
}

interface BingImage {
  name: string
  thumbnailUrl: string
  contentUrl: string
  hostPageUrl: string
  width?: number
  height?: number
}

interface BingWebSearchResponse {
  _type: string
  queryContext: { originalQuery: string }
  webPages?: { totalEstimatedMatches: number; value: BingWebPage[] }
  news?: { value: BingNewsArticle[] }
  images?: { value: BingImage[] }
  computation?: { expression: string; value: string }
}

interface BingNewsSearchResponse {
  _type: string
  value: BingNewsArticle[]
  totalEstimatedMatches?: number
}

interface BingImageSearchResponse {
  _type: string
  value: BingImage[]
  totalEstimatedMatches?: number
}

function mapRecencyToFreshness(recency?: SearchRecency): string | undefined {
  if (!recency || recency === "any") return undefined
  const mapping: Record<SearchRecency, string> = {
    day: "Day",
    week: "Week",
    month: "Month",
    year: "",
    any: "",
  }
  return mapping[recency] || undefined
}

export async function searchWithBing(
  query: string,
  apiKey: string,
  options: BingSearchOptions = {}
): Promise<SearchResponse> {
  const {
    maxResults = 10,
    country,
    language,
    recency,
    safeSearch = "Moderate",
    textDecorations = false,
    textFormat = "Raw",
    responseFilter,
  } = options

  if (!apiKey) {
    throw new Error("Bing API key is required")
  }

  const startTime = Date.now()

  const params = new URLSearchParams({
    q: query,
    count: maxResults.toString(),
    safeSearch,
    textDecorations: textDecorations.toString(),
    textFormat,
  })

  if (country) params.append("cc", country)
  if (language) params.append("setLang", language)

  const freshness = mapRecencyToFreshness(recency)
  if (freshness) params.append("freshness", freshness)

  if (responseFilter && responseFilter.length > 0) {
    params.append("responseFilter", responseFilter.join(","))
  }

  try {
    const response = await bingFetch(`${BING_WEB_SEARCH_URL}?${params.toString()}`, {
      method: "GET",
      headers: { "Ocp-Apim-Subscription-Key": apiKey },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Bing API error: ${response.status} - ${errorText}`)
    }

    const data: BingWebSearchResponse = await response.json()

    const results: SearchResult[] = (data.webPages?.value || []).map((page, index) => ({
      title: page.name,
      url: page.url,
      content: page.snippet,
      score: 1 - index * 0.05,
      publishedDate: page.dateLastCrawled,
      thumbnail: page.thumbnailUrl,
    }))

    let images: SearchImage[] | undefined
    if (data.images?.value) {
      images = data.images.value.map((img) => ({
        url: img.contentUrl,
        thumbnailUrl: img.thumbnailUrl,
        title: img.name,
        width: img.width,
        height: img.height,
      }))
    }

    let answer: string | undefined
    if (data.computation) {
      answer = `${data.computation.expression} = ${data.computation.value}`
    }

    return {
      provider: "bing",
      query,
      answer,
      results,
      images,
      responseTime: Date.now() - startTime,
      totalResults: data.webPages?.totalEstimatedMatches,
    }
  } catch (error) {
    log.error("Bing search error", error)
    throw new Error(
      error instanceof Error
        ? `Bing search failed: ${error.message}`
        : "Bing search failed: Unknown error"
    )
  }
}

export async function searchNewsWithBing(
  query: string,
  apiKey: string,
  options: Omit<BingSearchOptions, "responseFilter"> = {}
): Promise<SearchResponse> {
  const { maxResults = 10, country, language, recency, safeSearch = "Moderate" } = options

  if (!apiKey) {
    throw new Error("Bing API key is required")
  }

  const startTime = Date.now()

  const params = new URLSearchParams({
    q: query,
    count: maxResults.toString(),
    safeSearch,
  })

  if (country) params.append("cc", country)
  if (language) params.append("setLang", language)

  const freshness = mapRecencyToFreshness(recency)
  if (freshness) params.append("freshness", freshness)

  try {
    const response = await bingFetch(`${BING_NEWS_SEARCH_URL}?${params.toString()}`, {
      method: "GET",
      headers: { "Ocp-Apim-Subscription-Key": apiKey },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Bing News API error: ${response.status} - ${errorText}`)
    }

    const data: BingNewsSearchResponse = await response.json()

    const results: SearchResult[] = data.value.map((article, index) => ({
      title: article.name,
      url: article.url,
      content: article.description,
      score: 1 - index * 0.05,
      publishedDate: article.datePublished,
      source: article.provider?.[0]?.name,
      thumbnail: article.image?.thumbnail?.contentUrl,
    }))

    return {
      provider: "bing",
      query,
      results,
      responseTime: Date.now() - startTime,
      totalResults: data.totalEstimatedMatches,
    }
  } catch (error) {
    log.error("Bing News search error", error)
    throw new Error(
      error instanceof Error
        ? `Bing News search failed: ${error.message}`
        : "Bing News search failed: Unknown error"
    )
  }
}

export async function searchImagesWithBing(
  query: string,
  apiKey: string,
  options: Omit<BingSearchOptions, "responseFilter"> = {}
): Promise<SearchResponse> {
  const { maxResults = 10, country, language, safeSearch = "Moderate" } = options

  if (!apiKey) {
    throw new Error("Bing API key is required")
  }

  const startTime = Date.now()

  const params = new URLSearchParams({
    q: query,
    count: maxResults.toString(),
    safeSearch,
  })

  if (country) params.append("cc", country)
  if (language) params.append("setLang", language)

  try {
    const response = await bingFetch(`${BING_IMAGE_SEARCH_URL}?${params.toString()}`, {
      method: "GET",
      headers: { "Ocp-Apim-Subscription-Key": apiKey },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Bing Image API error: ${response.status} - ${errorText}`)
    }

    const data: BingImageSearchResponse = await response.json()

    const images: SearchImage[] = data.value.map((img) => ({
      url: img.contentUrl,
      thumbnailUrl: img.thumbnailUrl,
      title: img.name,
      width: img.width,
      height: img.height,
    }))

    return {
      provider: "bing",
      query,
      results: [],
      images,
      responseTime: Date.now() - startTime,
      totalResults: data.totalEstimatedMatches,
    }
  } catch (error) {
    log.error("Bing Image search error", error)
    throw new Error(
      error instanceof Error
        ? `Bing Image search failed: ${error.message}`
        : "Bing Image search failed: Unknown error"
    )
  }
}

export async function testBingConnection(apiKey: string): Promise<boolean> {
  try {
    await searchWithBing("test", apiKey, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}
