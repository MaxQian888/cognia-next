/**
 * Google Custom Search Provider
 * Google Programmable Search Engine API
 * https://developers.google.com/custom-search/v1/overview
 */

import type {
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchImage,
  SearchRecency,
} from "@/lib/search/types"
import { googleFetch } from "../proxy-search-fetch"
import { log } from "../log"

const GOOGLE_SEARCH_URL = "https://www.googleapis.com/customsearch/v1"

export interface GoogleSearchOptions extends Omit<SearchOptions, "searchType"> {
  cx?: string
  googleSearchType?: "image" | "web"
  siteSearch?: string
  siteSearchFilter?: "e" | "i"
  exactTerms?: string
  excludeTerms?: string
  linkSite?: string
  orTerms?: string
  fileType?: string
  rights?: string
  imgSize?: "huge" | "icon" | "large" | "medium" | "small" | "xlarge" | "xxlarge"
  imgType?: "clipart" | "face" | "lineart" | "stock" | "photo" | "animated"
  imgColorType?: "color" | "gray" | "mono" | "trans"
  imgDominantColor?: string
  safe?: "active" | "off"
  sort?: string
  start?: number
}

interface GoogleSearchItem {
  kind: string
  title: string
  htmlTitle?: string
  link: string
  displayLink: string
  snippet: string
  htmlSnippet?: string
  cacheId?: string
  formattedUrl?: string
  htmlFormattedUrl?: string
  pagemap?: {
    cse_thumbnail?: Array<{ src: string; width: string; height: string }>
    cse_image?: Array<{ src: string }>
    metatags?: Array<Record<string, string>>
    article?: Array<{ datePublished?: string }>
  }
  image?: {
    contextLink: string
    height: number
    width: number
    byteSize: number
    thumbnailLink: string
    thumbnailHeight: number
    thumbnailWidth: number
  }
  mime?: string
  fileFormat?: string
}

interface GoogleSearchResponse {
  kind: string
  url: { type: string; template: string }
  queries: {
    request: Array<{ totalResults: string; count: number; startIndex: number }>
    nextPage?: Array<{ totalResults: string; count: number; startIndex: number }>
  }
  context?: { title: string }
  searchInformation: {
    searchTime: number
    formattedSearchTime: string
    totalResults: string
    formattedTotalResults: string
  }
  items?: GoogleSearchItem[]
  spelling?: { correctedQuery: string; htmlCorrectedQuery: string }
}

function mapRecencyToDateRestrict(recency?: SearchRecency): string | undefined {
  if (!recency || recency === "any") return undefined
  const mapping: Record<SearchRecency, string> = {
    day: "d1",
    week: "w1",
    month: "m1",
    year: "y1",
    any: "",
  }
  return mapping[recency]
}

export async function searchWithGoogle(
  query: string,
  apiKey: string,
  options: GoogleSearchOptions = {}
): Promise<SearchResponse> {
  const {
    maxResults = 10,
    cx,
    googleSearchType,
    country,
    language,
    recency,
    siteSearch,
    siteSearchFilter,
    exactTerms,
    excludeTerms,
    fileType,
    safe = "active",
    start = 1,
  } = options

  if (!apiKey) {
    throw new Error("Google API key is required")
  }

  if (!cx) {
    throw new Error("Google Custom Search Engine ID (cx) is required")
  }

  const startTime = Date.now()

  const params = new URLSearchParams({
    key: apiKey,
    cx,
    q: query,
    num: Math.min(maxResults, 10).toString(),
    start: start.toString(),
    safe,
  })

  if (googleSearchType) params.append("searchType", googleSearchType)

  if (country) {
    params.append("gl", country)
    params.append("cr", `country${country.toUpperCase()}`)
  }

  if (language) {
    params.append("lr", `lang_${language}`)
    params.append("hl", language)
  }

  const dateRestrict = mapRecencyToDateRestrict(recency)
  if (dateRestrict) params.append("dateRestrict", dateRestrict)

  if (siteSearch) {
    params.append("siteSearch", siteSearch)
    if (siteSearchFilter) params.append("siteSearchFilter", siteSearchFilter)
  }

  if (exactTerms) params.append("exactTerms", exactTerms)
  if (excludeTerms) params.append("excludeTerms", excludeTerms)
  if (fileType) params.append("fileType", fileType)

  try {
    const response = await googleFetch(`${GOOGLE_SEARCH_URL}?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const errorMessage = errorData?.error?.message || response.statusText
      throw new Error(`Google API error: ${response.status} - ${errorMessage}`)
    }

    const data: GoogleSearchResponse = await response.json()

    let results: SearchResult[] = []
    let images: SearchImage[] | undefined

    if (data.items) {
      if (googleSearchType === "image") {
        images = data.items.map((item) => ({
          url: item.link,
          thumbnailUrl: item.image?.thumbnailLink,
          title: item.title,
          width: item.image?.width,
          height: item.image?.height,
        }))
      } else {
        results = data.items.map((item, index) => {
          let publishedDate: string | undefined
          if (item.pagemap?.article?.[0]?.datePublished) {
            publishedDate = item.pagemap.article[0].datePublished
          } else if (item.pagemap?.metatags?.[0]?.["article:published_time"]) {
            publishedDate = item.pagemap.metatags[0]["article:published_time"]
          }

          return {
            title: item.title,
            url: item.link,
            content: item.snippet,
            score: 1 - index * 0.05,
            publishedDate,
            source: item.displayLink,
            thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src || item.pagemap?.cse_image?.[0]?.src,
          }
        })
      }
    }

    return {
      provider: "google",
      query,
      results,
      images,
      responseTime: Date.now() - startTime,
      totalResults: parseInt(data.searchInformation.totalResults, 10),
    }
  } catch (error) {
    log.error("Google search error", error)
    throw new Error(
      error instanceof Error
        ? `Google search failed: ${error.message}`
        : "Google search failed: Unknown error"
    )
  }
}

export async function searchImagesWithGoogle(
  query: string,
  apiKey: string,
  options: Omit<GoogleSearchOptions, "googleSearchType"> = {}
): Promise<SearchResponse> {
  return searchWithGoogle(query, apiKey, { ...options, googleSearchType: "image" })
}

export async function testGoogleConnection(apiKey: string, cx: string): Promise<boolean> {
  try {
    await searchWithGoogle("test", apiKey, { cx, maxResults: 1 })
    return true
  } catch {
    return false
  }
}
