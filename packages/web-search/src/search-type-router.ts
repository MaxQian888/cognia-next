/**
 * Search Type Router
 * Routes search requests to appropriate provider functions based on search type
 */

import type {
  SearchResponse,
  SearchOptions,
  SearchType,
  SearchProviderType,
  SearchProviderSettings,
} from "./types"
import { getEnabledProviders } from "./types"

import {
  searchWithBrave,
  searchNewsWithBrave,
  searchImagesWithBrave,
  searchVideosWithBrave,
} from "./providers/brave"
import { searchWithBing, searchNewsWithBing, searchImagesWithBing } from "./providers/bing"
import {
  searchWithGoogle,
  searchImagesWithGoogle,
  type GoogleSearchOptions,
} from "./providers/google"
import {
  searchWithSearchAPI,
  searchNewsWithSearchAPI,
  searchImagesWithSearchAPI,
  searchScholarWithSearchAPI,
} from "./providers/searchapi"
import {
  searchWithSerpAPI,
  searchNewsWithSerpAPI,
  searchImagesWithSerpAPI,
} from "./providers/serpapi"
import {
  searchWithSerper,
  searchNewsWithSerper,
  searchImagesWithSerper,
  searchVideosWithSerper,
  searchScholarWithSerper,
} from "./providers/serper"
import { searchWithExa, findSimilarWithExa, getContentsWithExa } from "./providers/exa"
import { searchWithTavily, type TavilySearchOptions } from "./providers/tavily"
import { searchWithPerplexity } from "./providers/perplexity"
import { searchWithGoogleAI } from "./providers/google-ai"
import { log } from "./log"

export interface SearchTypeRouterOptions extends SearchOptions {
  similarUrl?: string
  contentUrls?: string[]
}

type RoutedSearchFunction = (
  query: string,
  settings: SearchProviderSettings,
  options?: SearchOptions
) => Promise<SearchResponse>

interface ProviderCapabilities {
  general: RoutedSearchFunction
  news?: RoutedSearchFunction
  images?: RoutedSearchFunction
  videos?: RoutedSearchFunction
  academic?: RoutedSearchFunction
}

const PROVIDER_CAPABILITIES: Record<SearchProviderType, ProviderCapabilities> = {
  brave: {
    general: (query, settings, options) => searchWithBrave(query, settings.apiKey, options),
    news: (query, settings, options) => searchNewsWithBrave(query, settings.apiKey, options),
    images: (query, settings, options) => searchImagesWithBrave(query, settings.apiKey, options),
    videos: (query, settings, options) => searchVideosWithBrave(query, settings.apiKey, options),
  },
  bing: {
    general: (query, settings, options) => searchWithBing(query, settings.apiKey, options),
    news: (query, settings, options) => searchNewsWithBing(query, settings.apiKey, options),
    images: (query, settings, options) => searchImagesWithBing(query, settings.apiKey, options),
  },
  google: {
    general: (query, settings, options) =>
      searchWithGoogle(query, settings.apiKey, buildGoogleOptions(settings, options)),
    images: (query, settings, options) =>
      searchImagesWithGoogle(query, settings.apiKey, buildGoogleOptions(settings, options)),
  },
  "google-ai": {
    general: (query, settings, options) => searchWithGoogleAI(query, settings.apiKey, options),
  },
  searchapi: {
    general: (query, settings, options) => searchWithSearchAPI(query, settings.apiKey, options),
    news: (query, settings, options) => searchNewsWithSearchAPI(query, settings.apiKey, options),
    images: (query, settings, options) =>
      searchImagesWithSearchAPI(query, settings.apiKey, options),
    academic: (query, settings, options) =>
      searchScholarWithSearchAPI(query, settings.apiKey, options),
  },
  serper: {
    general: (query, settings, options) => searchWithSerper(query, settings.apiKey, options),
    news: (query, settings, options) => searchNewsWithSerper(query, settings.apiKey, options),
    images: (query, settings, options) => searchImagesWithSerper(query, settings.apiKey, options),
    videos: (query, settings, options) => searchVideosWithSerper(query, settings.apiKey, options),
    academic: (query, settings, options) =>
      searchScholarWithSerper(query, settings.apiKey, options),
  },
  serpapi: {
    general: (query, settings, options) => searchWithSerpAPI(query, settings.apiKey, options),
    news: (query, settings, options) => searchNewsWithSerpAPI(query, settings.apiKey, options),
    images: (query, settings, options) => searchImagesWithSerpAPI(query, settings.apiKey, options),
  },
  exa: {
    general: (query, settings, options) => searchWithExa(query, settings.apiKey, options),
    academic: (query, settings, options) => searchWithExa(query, settings.apiKey, options),
  },
  tavily: {
    general: (query, settings, options) =>
      searchWithTavily(query, settings.apiKey, normalizeTavilyOptions(options)),
    news: (query, settings, options) =>
      searchWithTavily(query, settings.apiKey, normalizeTavilyOptions(options)),
  },
  perplexity: {
    general: (query, settings, options) => searchWithPerplexity(query, settings.apiKey, options),
    news: (query, settings, options) => searchWithPerplexity(query, settings.apiKey, options),
  },
}

function normalizeTavilyOptions(options?: SearchOptions): TavilySearchOptions {
  if (!options) return {}

  const includeRawContent = options.includeRawContent === true ? "text" : options.includeRawContent

  return { ...options, includeRawContent }
}

function buildGoogleOptions(
  settings: SearchProviderSettings,
  options?: SearchOptions
): GoogleSearchOptions {
  const cx = settings.cx?.trim()
  if (!cx) {
    throw new Error("Google Custom Search Engine ID (cx) is required")
  }

  return {
    cx,
    maxResults: options?.maxResults,
    country: options?.country,
    language: options?.language,
    recency: options?.recency,
  }
}

export function getProvidersForType(searchType: SearchType): SearchProviderType[] {
  const providers: SearchProviderType[] = []

  for (const [providerId, capabilities] of Object.entries(PROVIDER_CAPABILITIES)) {
    if (searchType === "general" || capabilities[searchType]) {
      providers.push(providerId as SearchProviderType)
    }
  }

  return providers
}

export function providerSupportsType(
  provider: SearchProviderType,
  searchType: SearchType
): boolean {
  const capabilities = PROVIDER_CAPABILITIES[provider]
  if (!capabilities) return false

  if (searchType === "general") return true
  return !!capabilities[searchType]
}

export function getBestProviderForType(
  searchType: SearchType,
  providerSettings: Partial<Record<SearchProviderType, SearchProviderSettings>>
): SearchProviderType | null {
  const enabledProviders = getEnabledProviders(providerSettings)

  for (const settings of enabledProviders) {
    if (providerSupportsType(settings.providerId, searchType)) {
      return settings.providerId
    }
  }

  return enabledProviders[0]?.providerId ?? null
}

export async function routeSearch(
  query: string,
  provider: SearchProviderType,
  settings: SearchProviderSettings,
  options: SearchTypeRouterOptions = {}
): Promise<SearchResponse> {
  const capabilities = PROVIDER_CAPABILITIES[provider]

  if (!capabilities) {
    throw new Error(`Unknown provider: ${provider}`)
  }

  const mergedOptions: SearchTypeRouterOptions = {
    ...(settings.defaultOptions || {}),
    ...options,
  }

  const searchType = mergedOptions.searchType || "general"

  const searchFn =
    searchType === "news"
      ? (capabilities.news ?? capabilities.general)
      : searchType === "images"
        ? (capabilities.images ?? capabilities.general)
        : searchType === "videos"
          ? (capabilities.videos ?? capabilities.general)
          : searchType === "academic"
            ? (capabilities.academic ?? capabilities.general)
            : capabilities.general

  log.debug(`Routing ${searchType} search to ${provider}`)

  return searchFn(query, settings, mergedOptions)
}

export async function searchNews(
  query: string,
  provider: SearchProviderType,
  settings: SearchProviderSettings,
  options?: SearchOptions
): Promise<SearchResponse> {
  return routeSearch(query, provider, settings, { ...options, searchType: "news" })
}

export async function searchImages(
  query: string,
  provider: SearchProviderType,
  settings: SearchProviderSettings,
  options?: SearchOptions
): Promise<SearchResponse> {
  return routeSearch(query, provider, settings, { ...options, searchType: "images" })
}

export async function searchVideos(
  query: string,
  provider: SearchProviderType,
  settings: SearchProviderSettings,
  options?: SearchOptions
): Promise<SearchResponse> {
  return routeSearch(query, provider, settings, { ...options, searchType: "videos" })
}

export async function searchAcademic(
  query: string,
  provider: "searchapi" | "exa" | "serper",
  settings: SearchProviderSettings,
  options?: SearchOptions
): Promise<SearchResponse> {
  return routeSearch(query, provider, settings, { ...options, searchType: "academic" })
}

export async function findSimilar(
  url: string,
  apiKey: string,
  options?: SearchOptions
): Promise<SearchResponse> {
  return findSimilarWithExa(url, apiKey, options)
}

export async function getContents(
  urls: string[],
  apiKey: string,
  options?: { text?: boolean | { maxCharacters?: number }; highlights?: boolean }
): Promise<SearchResponse> {
  const startTime = Date.now()
  const results = await getContentsWithExa(urls, apiKey, options)

  return {
    provider: "exa",
    query: urls.join(", "),
    results,
    responseTime: Date.now() - startTime,
    totalResults: results.length,
  }
}

export async function autoRouteSearch(
  query: string,
  searchType: SearchType,
  providerSettings: Partial<Record<SearchProviderType, SearchProviderSettings>>,
  options?: SearchOptions
): Promise<SearchResponse> {
  const provider = getBestProviderForType(searchType, providerSettings)

  if (!provider) {
    throw new Error(`No enabled provider available for search type: ${searchType}`)
  }

  const settings = providerSettings[provider]

  if (!settings) {
    throw new Error(`Provider settings not found for: ${provider}`)
  }

  log.debug(`Auto-routing ${searchType} search to ${provider}`)

  return routeSearch(query, provider, settings, {
    ...options,
    searchType,
  })
}
