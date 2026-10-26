/**
 * Search Type Router
 *
 * The single mapping from (provider, search type, engine, controls) to the
 * adapter call that actually runs. Everything a UI badge, a validator or the
 * executor claims about a provider is derived from {@link ADAPTERS} here, so an
 * advertised specialization is always one the adapter implements.
 *
 * An explicit request this mapping cannot serve — a search type the provider
 * has no adapter for, an engine it does not list, or a mandatory safe-search
 * level it cannot enforce at the wire — fails with a
 * {@link SearchCapabilityError} BEFORE any network I/O. It is never silently
 * downgraded to general search.
 */

import type {
  SafeSearchLevel,
  SearchOptions,
  SearchProviderSettings,
  SearchProviderType,
  SearchRecency,
  SearchResponse,
  SearchType,
} from "./types"
import { getEnabledProviders, isProviderRetired, SEARCH_PROVIDERS } from "./types"
import { stripUndefined } from "./strip-undefined"

import {
  searchWithBrave,
  searchNewsWithBrave,
  searchImagesWithBrave,
  searchVideosWithBrave,
} from "./providers/brave"
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
  type SearchAPIEngine,
} from "./providers/searchapi"
import {
  searchWithSerpAPI,
  searchNewsWithSerpAPI,
  searchImagesWithSerpAPI,
  type SerpAPIEngine,
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
import { searchWithGoogleAI, GOOGLE_AI_DEFAULT_MODEL } from "./providers/google-ai"
import { searchWithDeepSeek } from "./providers/deepseek"
import { searchWithTinyFish } from "./providers/tinyfish"
import { searchWithSearXNG, SEARXNG_ENGINE_PATTERN } from "./providers/searxng"
import { log } from "./log"

export interface SearchTypeRouterOptions extends SearchOptions {
  similarUrl?: string
  contentUrls?: string[]
}

type RoutedSearchFunction = (
  query: string,
  settings: SearchProviderSettings,
  options: SearchOptions
) => Promise<SearchResponse>

/** Which optional request controls an adapter carries to the vendor. */
interface AdapterControls {
  recency: boolean
  country: boolean
  language: boolean
  /** Native include/exclude domain filter (the host filters results either way). */
  domains: boolean
}

interface AdapterEntry {
  types: { general: RoutedSearchFunction } & Partial<Record<SearchType, RoutedSearchFunction>>
  /**
   * Safe-search levels the adapter can enforce at the wire. A level absent
   * here is honoured only as advisory (disclosed as degraded); a mandatory
   * level absent here makes the provider ineligible.
   */
  safeSearch: readonly SafeSearchLevel[]
  /** `general` searches accept a provider-scoped engine. */
  engines: boolean
  controls: AdapterControls
}

const NONE: AdapterControls = { recency: false, country: false, language: false, domains: false }

/** Map the canonical level onto Google-family `safe=active|off` (active filters explicit results). */
function googleSafe(level: SafeSearchLevel | undefined): "active" | "off" {
  return level === "off" ? "off" : "active"
}

const ADAPTERS: Record<SearchProviderType, AdapterEntry> = {
  brave: {
    types: {
      general: (q, s, o) => searchWithBrave(q, s.apiKey, withBraveSafe(o)),
      news: (q, s, o) => searchNewsWithBrave(q, s.apiKey, withBraveSafe(o)),
      // Brave image search accepts only off|strict; moderate is enforced as strict.
      images: (q, s, o) =>
        searchImagesWithBrave(q, s.apiKey, {
          ...o,
          safesearch: o.safeSearch === "off" ? "off" : "strict",
        }),
      videos: (q, s, o) => searchVideosWithBrave(q, s.apiKey, withBraveSafe(o)),
    },
    safeSearch: ["off", "moderate", "strict"],
    engines: false,
    controls: { recency: true, country: true, language: true, domains: false },
  },
  // Retired 2025-08-11. Kept so stored records stay typed; never executed.
  bing: {
    types: {
      general: async () => {
        throw new SearchCapabilityError("bing", "retired", "Bing Web Search API was retired")
      },
    },
    safeSearch: [],
    engines: false,
    controls: NONE,
  },
  google: {
    types: {
      general: (q, s, o) => searchWithGoogle(q, s.apiKey, buildGoogleOptions(s, o)),
      images: (q, s, o) => searchImagesWithGoogle(q, s.apiKey, buildGoogleOptions(s, o)),
    },
    safeSearch: ["off", "moderate", "strict"],
    engines: false,
    controls: { recency: true, country: true, language: true, domains: false },
  },
  "google-ai": {
    types: {
      general: (q, s, o) =>
        searchWithGoogleAI(q, s.apiKey, {
          ...o,
          model: s.model?.trim() || GOOGLE_AI_DEFAULT_MODEL,
        }),
    },
    safeSearch: [],
    engines: false,
    controls: NONE,
  },
  searchapi: {
    types: {
      general: (q, s, o) =>
        searchWithSearchAPI(q, s.apiKey, {
          ...o,
          engine: resolveEngine("searchapi", s, o) as SearchAPIEngine,
          safeSearch: o.safeSearch ?? "moderate",
        }),
      news: (q, s, o) => searchNewsWithSearchAPI(q, s.apiKey, withoutEngine(o)),
      images: (q, s, o) => searchImagesWithSearchAPI(q, s.apiKey, withoutEngine(o)),
      academic: (q, s, o) => searchScholarWithSearchAPI(q, s.apiKey, withoutEngine(o)),
    },
    safeSearch: ["off", "moderate", "strict"],
    engines: true,
    controls: { recency: true, country: true, language: true, domains: false },
  },
  serper: {
    types: {
      general: (q, s, o) => searchWithSerper(q, s.apiKey, o),
      news: (q, s, o) => searchNewsWithSerper(q, s.apiKey, o),
      images: (q, s, o) => searchImagesWithSerper(q, s.apiKey, o),
      videos: (q, s, o) => searchVideosWithSerper(q, s.apiKey, o),
      academic: (q, s, o) => searchScholarWithSerper(q, s.apiKey, o),
    },
    safeSearch: [],
    engines: false,
    controls: { recency: true, country: true, language: true, domains: false },
  },
  serpapi: {
    types: {
      general: (q, s, o) =>
        searchWithSerpAPI(q, s.apiKey, {
          ...o,
          engine: resolveEngine("serpapi", s, o) as SerpAPIEngine,
          safeSearch: o.safeSearch === "off" ? "off" : "active",
        }),
      news: (q, s, o) =>
        searchNewsWithSerpAPI(q, s.apiKey, {
          ...withoutEngine(o),
          safeSearch: googleSafe(o.safeSearch),
        }),
      images: (q, s, o) =>
        searchImagesWithSerpAPI(q, s.apiKey, {
          ...withoutEngine(o),
          safeSearch: googleSafe(o.safeSearch),
        }),
    },
    safeSearch: ["off", "moderate", "strict"],
    engines: true,
    controls: { recency: true, country: true, language: true, domains: false },
  },
  exa: {
    types: {
      general: (q, s, o) => searchWithExa(q, s.apiKey, withExaRecency(o)),
      news: (q, s, o) => searchWithExa(q, s.apiKey, { ...withExaRecency(o), category: "news" }),
      academic: (q, s, o) =>
        searchWithExa(q, s.apiKey, { ...withExaRecency(o), category: "research paper" }),
    },
    safeSearch: [],
    engines: false,
    controls: { recency: true, country: false, language: false, domains: true },
  },
  tavily: {
    types: {
      general: (q, s, o) => searchWithTavily(q, s.apiKey, normalizeTavilyOptions(o, "general")),
      news: (q, s, o) => searchWithTavily(q, s.apiKey, normalizeTavilyOptions(o, "news")),
    },
    // `safe_search: true` filters adult content; moderate is enforced as that.
    safeSearch: ["off", "moderate", "strict"],
    engines: false,
    controls: { recency: true, country: false, language: false, domains: true },
  },
  perplexity: {
    types: {
      general: (q, s, o) => searchWithPerplexity(q, s.apiKey, o),
    },
    safeSearch: [],
    engines: false,
    controls: { recency: true, country: true, language: true, domains: true },
  },
  deepseek: {
    types: {
      general: (q, s, o) => searchWithDeepSeek(q, s.apiKey, o),
    },
    safeSearch: [],
    engines: false,
    // Carried as `after:` / `lang:` / `site:` query operators.
    controls: { recency: true, country: false, language: true, domains: true },
  },
  tinyfish: {
    types: {
      general: (q, s, o) => searchWithTinyFish(q, s.apiKey, o),
      news: (q, s, o) => searchWithTinyFish(q, s.apiKey, o),
      academic: (q, s, o) => searchWithTinyFish(q, s.apiKey, o),
    },
    safeSearch: [],
    engines: false,
    controls: { recency: true, country: false, language: true, domains: true },
  },
  searxng: {
    types: {
      general: (q, s, o) => searchWithSearXNG(q, s, o, "general"),
      news: (q, s, o) => searchWithSearXNG(q, s, o, "news"),
      images: (q, s, o) => searchWithSearXNG(q, s, o, "images"),
      videos: (q, s, o) => searchWithSearXNG(q, s, o, "videos"),
      academic: (q, s, o) => searchWithSearXNG(q, s, o, "academic"),
    },
    safeSearch: ["off", "moderate", "strict"],
    engines: true,
    controls: { recency: true, country: false, language: true, domains: false },
  },
}

/** Why a provider cannot serve a request; raised before any network I/O. */
export type SearchCapabilityReason =
  | "retired"
  | "unsupported-type"
  | "unsupported-engine"
  | "safe-search-unenforceable"
  | "unknown-provider"

export class SearchCapabilityError extends Error {
  readonly provider: SearchProviderType
  readonly reason: SearchCapabilityReason
  constructor(provider: SearchProviderType, reason: SearchCapabilityReason, message: string) {
    super(message)
    this.name = "SearchCapabilityError"
    this.provider = provider
    this.reason = reason
  }
}

export function isSearchCapabilityError(error: unknown): error is SearchCapabilityError {
  return error instanceof SearchCapabilityError
}

/** What one provider's adapter really supports — the source for badges and validation. */
export interface EffectiveSearchCapabilities {
  provider: SearchProviderType
  types: SearchType[]
  safeSearch: readonly SafeSearchLevel[]
  engines: readonly { id: string; label: string }[]
  /** Free-form engine names (SearXNG instances define their own engine set). */
  freeFormEngines: boolean
  controls: AdapterControls
  answer: boolean
  rawContent: boolean
}

const ALL_TYPES: SearchType[] = ["general", "news", "academic", "images", "videos"]

export function getEffectiveSearchCapabilities(
  provider: SearchProviderType
): EffectiveSearchCapabilities | null {
  const entry = ADAPTERS[provider]
  const config = SEARCH_PROVIDERS[provider]
  if (!entry || !config) return null
  return {
    provider,
    types: ALL_TYPES.filter((t) => Boolean(entry.types[t])),
    safeSearch: entry.safeSearch,
    engines: entry.engines ? (config.engines ?? []) : [],
    freeFormEngines: entry.engines && config.integration === "self-hosted",
    controls: entry.controls,
    answer: config.features.aiAnswer,
    rawContent: config.features.contentExtraction,
  }
}

/** True when `level` must be enforced at the wire rather than honoured best-effort. */
export function isSafeSearchMandatory(
  options: Pick<SearchOptions, "safeSearch" | "safeSearchRequired">
): boolean {
  if (options.safeSearch === "strict") return true
  return options.safeSearch === "moderate" && options.safeSearchRequired === true
}

/** The engine a request resolves to for `provider`, or `undefined` for single-engine providers. */
export function resolveEngine(
  provider: SearchProviderType,
  settings: Pick<SearchProviderSettings, "engine"> | undefined,
  options: Pick<SearchOptions, "engine">
): string | undefined {
  const entry = ADAPTERS[provider]
  if (!entry?.engines) return undefined
  return (
    options.engine?.trim() ||
    settings?.engine?.trim() ||
    SEARCH_PROVIDERS[provider]?.defaultEngine ||
    undefined
  )
}

/**
 * Check one provider against one effective request, without I/O. Returns the
 * capability error the request would raise, or `null` when it is servable.
 */
export function checkProviderEligibility(
  provider: SearchProviderType,
  settings: Pick<SearchProviderSettings, "engine"> | undefined,
  options: SearchOptions
): SearchCapabilityError | null {
  const entry = ADAPTERS[provider]
  if (!entry || !SEARCH_PROVIDERS[provider]) {
    return new SearchCapabilityError(provider, "unknown-provider", `Unknown provider: ${provider}`)
  }
  if (isProviderRetired(provider)) {
    return new SearchCapabilityError(
      provider,
      "retired",
      `${SEARCH_PROVIDERS[provider].name} has been retired by its vendor and cannot run`
    )
  }
  const searchType = options.searchType ?? "general"
  if (!entry.types[searchType]) {
    return new SearchCapabilityError(
      provider,
      "unsupported-type",
      `${SEARCH_PROVIDERS[provider].name} does not support ${searchType} search`
    )
  }
  const engine = options.engine?.trim() || settings?.engine?.trim()
  if (engine) {
    const config = SEARCH_PROVIDERS[provider]
    const supported = !entry.engines
      ? false
      : config.integration === "self-hosted"
        ? SEARXNG_ENGINE_PATTERN.test(engine)
        : searchType === "general" && Boolean(config.engines?.some((e) => e.id === engine))
    // A non-general type on an engine-capable SERP provider runs on its fixed
    // vertical (Google News/Images/Scholar); only the default engine matches it.
    const defaultOnly =
      entry.engines &&
      config.integration !== "self-hosted" &&
      searchType !== "general" &&
      engine === config.defaultEngine
    if (!supported && !defaultOnly) {
      return new SearchCapabilityError(
        provider,
        "unsupported-engine",
        `${config.name} cannot serve engine "${engine}" for ${searchType} search`
      )
    }
  }
  if (isSafeSearchMandatory(options) && !entry.safeSearch.includes(options.safeSearch!)) {
    return new SearchCapabilityError(
      provider,
      "safe-search-unenforceable",
      `${SEARCH_PROVIDERS[provider].name} cannot enforce ${options.safeSearch} safe search`
    )
  }
  return null
}

/** Advisory controls the adapter cannot carry for this request. */
export function degradedControlsFor(
  provider: SearchProviderType,
  options: SearchOptions
): NonNullable<NonNullable<SearchResponse["diagnostics"]>["degradedControls"]> {
  const entry = ADAPTERS[provider]
  if (!entry) return []
  const degraded: NonNullable<NonNullable<SearchResponse["diagnostics"]>["degradedControls"]> = []
  if (options.safeSearch && !entry.safeSearch.includes(options.safeSearch))
    degraded.push("safeSearch")
  if (options.recency && options.recency !== "any" && !entry.controls.recency)
    degraded.push("recency")
  if (options.country && !entry.controls.country) degraded.push("country")
  if (options.language && !entry.controls.language) degraded.push("language")
  return degraded
}

function withoutEngine(options: SearchOptions): Omit<SearchOptions, "engine"> {
  const { engine: _engine, ...rest } = options
  return rest
}

function withBraveSafe<T extends SearchOptions>(options: T): T & { safesearch: SafeSearchLevel } {
  return { ...options, safesearch: options.safeSearch ?? "moderate" }
}

function recencyStartDate(
  recency: SearchRecency | undefined,
  now = Date.now()
): string | undefined {
  const days: Partial<Record<SearchRecency, number>> = { day: 1, week: 7, month: 31, year: 366 }
  const span = recency ? days[recency] : undefined
  if (!span) return undefined
  return new Date(now - span * 24 * 60 * 60 * 1000).toISOString()
}

function withExaRecency(options: SearchOptions): SearchOptions & { startPublishedDate?: string } {
  const startPublishedDate = recencyStartDate(options.recency)
  return startPublishedDate ? { ...options, startPublishedDate } : options
}

function normalizeTavilyOptions(
  options: SearchOptions,
  topic: "general" | "news"
): TavilySearchOptions {
  const includeRawContent = options.includeRawContent === true ? "text" : options.includeRawContent
  return { ...options, includeRawContent, topic }
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
    safe: googleSafe(options?.safeSearch),
    signal: options?.signal,
  }
}

export function getProvidersForType(searchType: SearchType): SearchProviderType[] {
  return (Object.keys(ADAPTERS) as SearchProviderType[]).filter(
    (provider) => !isProviderRetired(provider) && Boolean(ADAPTERS[provider].types[searchType])
  )
}

export function providerSupportsType(
  provider: SearchProviderType,
  searchType: SearchType
): boolean {
  const entry = ADAPTERS[provider]
  if (!entry || isProviderRetired(provider)) return false
  return Boolean(entry.types[searchType])
}

/**
 * The highest-priority enabled provider whose adapter implements `searchType`,
 * or `null`. Never substitutes a provider that would run general search for a
 * specialized request.
 */
export function getBestProviderForType(
  searchType: SearchType,
  providerSettings: Partial<Record<SearchProviderType, SearchProviderSettings>>
): SearchProviderType | null {
  for (const settings of getEnabledProviders(providerSettings)) {
    if (providerSupportsType(settings.providerId, searchType)) {
      return settings.providerId
    }
  }
  return null
}

export async function routeSearch(
  query: string,
  provider: SearchProviderType,
  settings: SearchProviderSettings,
  options: SearchTypeRouterOptions = {}
): Promise<SearchResponse> {
  // Same precedence ladder as `search()` — explicit `undefined` fields in the
  // call-time options must not clobber the provider's `defaultOptions`.
  const mergedOptions: SearchTypeRouterOptions = {
    ...stripUndefined(settings.defaultOptions || {}),
    ...stripUndefined(options),
  }
  const searchType = mergedOptions.searchType || "general"

  const ineligible = checkProviderEligibility(provider, settings, mergedOptions)
  if (ineligible) throw ineligible

  const entry = ADAPTERS[provider]
  const searchFn = entry.types[searchType] ?? entry.types.general
  log.debug(`Routing ${searchType} search to ${provider}`)

  const response = await searchFn(query, settings, mergedOptions)
  // Static capability gaps plus whatever the adapter itself could not apply.
  const degraded = [
    ...new Set([
      ...(response.diagnostics?.degradedControls ?? []),
      ...degradedControlsFor(provider, mergedOptions),
    ]),
  ]
  const engine = resolveEngine(provider, settings, mergedOptions)
  return {
    ...response,
    searchType,
    ...(engine && searchType === "general" ? { engine } : {}),
    ...(degraded.length > 0
      ? { diagnostics: { ...(response.diagnostics ?? {}), degradedControls: degraded } }
      : {}),
  }
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
