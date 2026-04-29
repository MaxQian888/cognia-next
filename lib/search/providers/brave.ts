/**
 * Brave Search Provider
 * Brave Search API - Privacy-focused search engine
 * https://brave.com/search/api/
 */

import type {
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchImage,
  SearchRecency,
} from "@/lib/search/types"
import { braveFetch } from "../proxy-search-fetch"
import { log } from "../log"

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
const BRAVE_NEWS_URL = "https://api.search.brave.com/res/v1/news/search"
const BRAVE_IMAGES_URL = "https://api.search.brave.com/res/v1/images/search"
const BRAVE_VIDEOS_URL = "https://api.search.brave.com/res/v1/videos/search"

export interface BraveSearchOptions extends SearchOptions {
  safesearch?: "off" | "moderate" | "strict"
  freshness?: "pd" | "pw" | "pm" | "py" | "none"
  textDecorations?: boolean
  spellcheck?: boolean
  goggles?: string[]
  units?: "metric" | "imperial"
  extraSnippets?: boolean
  summary?: boolean
}

interface BraveWebResult {
  title: string
  url: string
  is_source_local: boolean
  is_source_both: boolean
  description: string
  page_age?: string
  page_fetched?: string
  profile?: { name: string; url: string; long_name: string; img: string }
  language?: string
  family_friendly?: boolean
  type?: string
  subtype?: string
  meta_url?: {
    scheme: string
    netloc: string
    hostname: string
    favicon: string
    path: string
  }
  thumbnail?: {
    src: string
    height?: number
    width?: number
    bg_color?: string
    original?: string
    logo?: boolean
    duplicated?: boolean
    theme?: string
  }
  extra_snippets?: string[]
}

interface BraveNewsResult {
  title: string
  url: string
  description: string
  age?: string
  page_age?: string
  meta_url?: {
    scheme: string
    netloc: string
    hostname: string
    favicon: string
    path: string
  }
  thumbnail?: { src: string; height?: number; width?: number }
  source?: string
}

interface BraveImageResult {
  title: string
  url: string
  source: string
  page_fetched?: string
  thumbnail?: { src: string; height?: number; width?: number }
  properties?: { url: string; height?: number; width?: number; format?: string }
}

interface BraveVideoResult {
  title: string
  url: string
  description?: string
  age?: string
  page_age?: string
  meta_url?: {
    scheme: string
    netloc: string
    hostname: string
    favicon: string
    path: string
  }
  thumbnail?: { src: string; height?: number; width?: number }
  video?: {
    duration?: string
    views?: string
    creator?: string
    publisher?: string
    requires_subscription?: boolean
  }
}

interface BraveSearchResponse {
  type: string
  query: {
    original: string
    show_strict_warning?: boolean
    is_navigational?: boolean
    is_news_breaking?: boolean
    spellcheck_off?: boolean
    country?: string
    bad_results?: boolean
    should_fallback?: boolean
    postal_code?: string
    city?: string
    header_country?: string
    more_results_available?: boolean
    state?: string
  }
  mixed?: {
    type: string
    main: Array<{ type: string; index?: number; all?: boolean }>
    top?: Array<{ type: string; index?: number }>
    side?: Array<{ type: string; index?: number }>
  }
  web?: {
    type: string
    results: BraveWebResult[]
    family_friendly?: boolean
  }
  news?: { type: string; results: BraveNewsResult[] }
  videos?: { type: string; results: BraveVideoResult[] }
  infobox?: {
    type: string
    title: string
    url: string
    description: string
    long_desc?: string
    images?: Array<{ src: string }>
    results?: Array<{ title: string; description: string; url: string }>
  }
  discussions?: {
    type: string
    results: Array<{
      type: string
      data: { title: string; url: string; description: string; age?: string }
    }>
  }
  summarizer?: { type: string; key: string }
}

interface BraveImagesResponse {
  type: string
  query: { original: string }
  results: BraveImageResult[]
}

function mapRecencyToFreshness(recency?: SearchRecency): string | undefined {
  if (!recency || recency === "any") return undefined
  const mapping: Record<SearchRecency, string> = {
    day: "pd",
    week: "pw",
    month: "pm",
    year: "py",
    any: "none",
  }
  return mapping[recency]
}

export async function searchWithBrave(
  query: string,
  apiKey: string,
  options: BraveSearchOptions = {}
): Promise<SearchResponse> {
  const {
    maxResults = 10,
    country,
    language,
    recency,
    safesearch = "moderate",
    textDecorations = false,
    spellcheck = true,
    extraSnippets = false,
    summary = false,
  } = options

  if (!apiKey) {
    throw new Error("Brave API key is required")
  }

  const startTime = Date.now()

  const params = new URLSearchParams({
    q: query,
    count: maxResults.toString(),
    safesearch,
    text_decorations: textDecorations.toString(),
    spellcheck: spellcheck.toString(),
    extra_snippets: extraSnippets.toString(),
    summary: summary.toString(),
  })

  if (country) params.append("country", country)
  if (language) {
    params.append("search_lang", language)
    params.append("ui_lang", language)
  }

  const freshness = mapRecencyToFreshness(recency)
  if (freshness) params.append("freshness", freshness)

  try {
    const response = await braveFetch(`${BRAVE_SEARCH_URL}?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Brave API error: ${response.status} - ${errorText}`)
    }

    const data: BraveSearchResponse = await response.json()

    const results: SearchResult[] = (data.web?.results || []).map((result, index) => ({
      title: result.title,
      url: result.url,
      content: result.description,
      score: 1 - index * 0.05,
      publishedDate: result.page_age,
      source: result.meta_url?.hostname,
      favicon: result.meta_url?.favicon,
      thumbnail: result.thumbnail?.src,
    }))

    let answer: string | undefined
    if (data.infobox?.description) {
      answer = data.infobox.description
      if (data.infobox.long_desc) answer = data.infobox.long_desc
    }

    return {
      provider: "brave",
      query,
      answer,
      results,
      responseTime: Date.now() - startTime,
    }
  } catch (error) {
    log.error("Brave search error", error)
    throw new Error(
      error instanceof Error
        ? `Brave search failed: ${error.message}`
        : "Brave search failed: Unknown error"
    )
  }
}

export async function searchNewsWithBrave(
  query: string,
  apiKey: string,
  options: BraveSearchOptions = {}
): Promise<SearchResponse> {
  const {
    maxResults = 10,
    country,
    language,
    recency,
    safesearch = "moderate",
    spellcheck = true,
  } = options

  if (!apiKey) {
    throw new Error("Brave API key is required")
  }

  const startTime = Date.now()

  const params = new URLSearchParams({
    q: query,
    count: maxResults.toString(),
    safesearch,
    spellcheck: spellcheck.toString(),
  })

  if (country) params.append("country", country)
  if (language) params.append("search_lang", language)

  const freshness = mapRecencyToFreshness(recency)
  if (freshness) params.append("freshness", freshness)

  try {
    const response = await braveFetch(`${BRAVE_NEWS_URL}?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Brave News API error: ${response.status} - ${errorText}`)
    }

    const data: BraveSearchResponse = await response.json()

    const results: SearchResult[] = (data.news?.results || []).map((result, index) => ({
      title: result.title,
      url: result.url,
      content: result.description,
      score: 1 - index * 0.05,
      publishedDate: result.page_age || result.age,
      source: result.source || result.meta_url?.hostname,
      favicon: result.meta_url?.favicon,
      thumbnail: result.thumbnail?.src,
    }))

    return {
      provider: "brave",
      query,
      results,
      responseTime: Date.now() - startTime,
    }
  } catch (error) {
    log.error("Brave News search error", error)
    throw new Error(
      error instanceof Error
        ? `Brave News search failed: ${error.message}`
        : "Brave News search failed: Unknown error"
    )
  }
}

export async function searchImagesWithBrave(
  query: string,
  apiKey: string,
  options: BraveSearchOptions = {}
): Promise<SearchResponse> {
  const { maxResults = 10, country, safesearch = "moderate", spellcheck = true } = options

  if (!apiKey) {
    throw new Error("Brave API key is required")
  }

  const startTime = Date.now()

  const params = new URLSearchParams({
    q: query,
    count: maxResults.toString(),
    safesearch,
    spellcheck: spellcheck.toString(),
  })

  if (country) params.append("country", country)

  try {
    const response = await braveFetch(`${BRAVE_IMAGES_URL}?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Brave Images API error: ${response.status} - ${errorText}`)
    }

    const data: BraveImagesResponse = await response.json()

    const images: SearchImage[] = data.results.map((result) => ({
      url: result.properties?.url || result.url,
      thumbnailUrl: result.thumbnail?.src,
      title: result.title,
      width: result.properties?.width,
      height: result.properties?.height,
    }))

    return {
      provider: "brave",
      query,
      results: [],
      images,
      responseTime: Date.now() - startTime,
    }
  } catch (error) {
    log.error("Brave Images search error", error)
    throw new Error(
      error instanceof Error
        ? `Brave Images search failed: ${error.message}`
        : "Brave Images search failed: Unknown error"
    )
  }
}

export async function searchVideosWithBrave(
  query: string,
  apiKey: string,
  options: BraveSearchOptions = {}
): Promise<SearchResponse> {
  const { maxResults = 10, country, language, safesearch = "moderate", spellcheck = true } = options

  if (!apiKey) {
    throw new Error("Brave API key is required")
  }

  const startTime = Date.now()

  const params = new URLSearchParams({
    q: query,
    count: maxResults.toString(),
    safesearch,
    spellcheck: spellcheck.toString(),
  })

  if (country) params.append("country", country)
  if (language) params.append("search_lang", language)

  try {
    const response = await braveFetch(`${BRAVE_VIDEOS_URL}?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Brave Videos API error: ${response.status} - ${errorText}`)
    }

    const data: BraveSearchResponse = await response.json()

    const results: SearchResult[] = (data.videos?.results || []).map((result, index) => ({
      title: result.title,
      url: result.url,
      content: result.description || "",
      score: 1 - index * 0.05,
      publishedDate: result.page_age || result.age,
      source: result.video?.publisher || result.meta_url?.hostname,
      thumbnail: result.thumbnail?.src,
    }))

    return {
      provider: "brave",
      query,
      results,
      responseTime: Date.now() - startTime,
    }
  } catch (error) {
    log.error("Brave Videos search error", error)
    throw new Error(
      error instanceof Error
        ? `Brave Videos search failed: ${error.message}`
        : "Brave Videos search failed: Unknown error"
    )
  }
}

export async function testBraveConnection(apiKey: string): Promise<boolean> {
  try {
    await searchWithBrave("test", apiKey, { maxResults: 1 })
    return true
  } catch {
    return false
  }
}
