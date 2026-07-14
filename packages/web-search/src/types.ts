/**
 * Search type definitions
 * Unified types for multi-provider web search
 */

/**
 * Supported search providers
 */
export type SearchProviderType =
  | "tavily"
  | "perplexity"
  | "exa"
  | "searchapi"
  | "serper"
  | "serpapi"
  | "bing"
  | "google"
  | "google-ai"
  | "brave"

/**
 * Search depth/quality level
 */
export type SearchDepth = "basic" | "advanced" | "deep"

/**
 * Search type for specialized searches
 */
export type SearchType = "general" | "news" | "academic" | "images" | "videos"

/**
 * Time range filter for search results
 */
export type SearchRecency = "day" | "week" | "month" | "year" | "any"

/**
 * Individual search result
 */
export interface SearchResult {
  title: string
  url: string
  content: string
  score: number
  publishedDate?: string
  source?: string
  favicon?: string
  thumbnail?: string
}

/**
 * Common search options across all providers
 */
export interface SearchOptions {
  maxResults?: number
  searchDepth?: SearchDepth
  searchType?: SearchType
  includeAnswer?: boolean
  includeRawContent?: boolean | "text" | "markdown"
  includeDomains?: string[]
  excludeDomains?: string[]
  recency?: SearchRecency
  country?: string
  language?: string
}

/**
 * Unified search response
 */
export interface SearchResponse {
  provider: SearchProviderType
  query: string
  answer?: string
  results: SearchResult[]
  responseTime: number
  totalResults?: number
  images?: SearchImage[]
}

/**
 * Search image result
 */
export interface SearchImage {
  url: string
  thumbnailUrl?: string
  title?: string
  width?: number
  height?: number
}

/**
 * Search provider configuration
 */
export interface SearchProviderConfig {
  id: SearchProviderType
  name: string
  description: string
  apiKeyRequired: boolean
  apiKeyPlaceholder: string
  apiKeyPrefix?: string
  docsUrl: string
  features: SearchProviderFeatures
  pricing?: {
    freeCredits?: number
    pricePerSearch?: number
  }
}

/**
 * Features supported by each provider
 */
export interface SearchProviderFeatures {
  aiAnswer: boolean
  newsSearch: boolean
  academicSearch: boolean
  imageSearch: boolean
  videoSearch: boolean
  domainFilter: boolean
  recencyFilter: boolean
  countryFilter: boolean
  contentExtraction: boolean
  streaming: boolean
}

/**
 * API-key rotation strategy for a search provider's multi-key pool.
 * Mirrors the AI-provider rotation vocabulary so the UI and mental model match.
 * - `round-robin`: cycle keys in order, one per request
 * - `random`: pick a random key each request
 * - `least-used`: prefer the key with the fewest requests this session
 */
export type SearchApiKeyRotationStrategy = "round-robin" | "random" | "least-used"

/**
 * Search provider settings stored in user preferences
 */
export interface SearchProviderSettings {
  providerId: SearchProviderType
  apiKey: string
  /**
   * Additional API keys for this provider. Combined with `apiKey` they form the
   * rotation pool: on each request one key is chosen (see `apiKeyRotationStrategy`),
   * and a rate-limited / dead key is skipped for the next retry (see the retry
   * loop in `search-service`). Empty/duplicate entries are ignored.
   */
  apiKeys?: string[]
  /** When true (and the pool has >1 key), rotate keys per request instead of always using `apiKey`. */
  apiKeyRotationEnabled?: boolean
  /** Rotation strategy for the key pool. Defaults to `round-robin`. */
  apiKeyRotationStrategy?: SearchApiKeyRotationStrategy
  /** Google Programmable Search Engine ID (required for providerId === 'google') */
  cx?: string
  enabled: boolean
  priority: number
  defaultOptions?: Partial<SearchOptions>
}

/**
 * Search settings state
 */
export interface SearchSettings {
  providers: Record<SearchProviderType, SearchProviderSettings>
  defaultProvider: SearchProviderType
  searchEnabled: boolean
  maxResults: number
  fallbackEnabled: boolean
  cacheEnabled: boolean
  cacheDuration: number
}

/**
 * Search provider definitions
 */
export const SEARCH_PROVIDERS: Record<SearchProviderType, SearchProviderConfig> = {
  tavily: {
    id: "tavily",
    name: "Tavily",
    description: "AI-optimized search engine with answer generation",
    apiKeyRequired: true,
    apiKeyPlaceholder: "tvly-xxxxxxxxxxxxx",
    apiKeyPrefix: "tvly-",
    docsUrl: "https://docs.tavily.com",
    features: {
      aiAnswer: true,
      newsSearch: true,
      academicSearch: false,
      imageSearch: true,
      videoSearch: false,
      domainFilter: true,
      recencyFilter: false,
      countryFilter: false,
      contentExtraction: true,
      streaming: false,
    },
    pricing: {
      freeCredits: 1000,
      pricePerSearch: 0.001,
    },
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    description: "High-quality search with recency and geo filters",
    apiKeyRequired: true,
    apiKeyPlaceholder: "pplx-xxxxxxxxxxxxx",
    apiKeyPrefix: "pplx-",
    docsUrl: "https://docs.perplexity.ai",
    features: {
      aiAnswer: false,
      newsSearch: true,
      academicSearch: false,
      imageSearch: false,
      videoSearch: false,
      domainFilter: true,
      recencyFilter: true,
      countryFilter: true,
      contentExtraction: false,
      streaming: false,
    },
    pricing: {
      pricePerSearch: 0.005,
    },
  },
  exa: {
    id: "exa",
    name: "Exa",
    description: "Neural search engine with semantic understanding",
    apiKeyRequired: true,
    apiKeyPlaceholder: "exa-xxxxxxxxxxxxx",
    docsUrl: "https://docs.exa.ai",
    features: {
      aiAnswer: true,
      newsSearch: true,
      academicSearch: true,
      imageSearch: false,
      videoSearch: false,
      domainFilter: true,
      recencyFilter: true,
      countryFilter: false,
      contentExtraction: true,
      streaming: false,
    },
    pricing: {
      freeCredits: 1000,
      pricePerSearch: 0.001,
    },
  },
  searchapi: {
    id: "searchapi",
    name: "SearchAPI",
    description: "Multi-engine aggregator (Google, Bing, Baidu)",
    apiKeyRequired: true,
    apiKeyPlaceholder: "xxxxxxxxxxxxx",
    docsUrl: "https://www.searchapi.io/docs",
    features: {
      aiAnswer: true,
      newsSearch: true,
      academicSearch: true,
      imageSearch: true,
      videoSearch: true,
      domainFilter: true,
      recencyFilter: true,
      countryFilter: true,
      contentExtraction: false,
      streaming: false,
    },
    pricing: {
      freeCredits: 100,
      pricePerSearch: 0.002,
    },
  },
  serper: {
    id: "serper",
    name: "Serper",
    description: "Google search results API via serper.dev",
    apiKeyRequired: true,
    apiKeyPlaceholder: "xxxxxxxxxxxxx",
    docsUrl: "https://serper.dev",
    features: {
      aiAnswer: false,
      newsSearch: true,
      academicSearch: true,
      imageSearch: true,
      videoSearch: true,
      domainFilter: false,
      recencyFilter: true,
      countryFilter: true,
      contentExtraction: false,
      streaming: false,
    },
    pricing: {
      freeCredits: 2500,
      pricePerSearch: 0.001,
    },
  },
  serpapi: {
    id: "serpapi",
    name: "SerpAPI",
    description: "Google search results API with rich features",
    apiKeyRequired: true,
    apiKeyPlaceholder: "xxxxxxxxxxxxx",
    docsUrl: "https://serpapi.com/search-api",
    features: {
      aiAnswer: false,
      newsSearch: true,
      academicSearch: true,
      imageSearch: true,
      videoSearch: true,
      domainFilter: false,
      recencyFilter: true,
      countryFilter: true,
      contentExtraction: false,
      streaming: false,
    },
    pricing: {
      freeCredits: 100,
      pricePerSearch: 0.004,
    },
  },
  bing: {
    id: "bing",
    name: "Bing Search",
    description: "Microsoft Bing Web Search API",
    apiKeyRequired: true,
    apiKeyPlaceholder: "xxxxxxxxxxxxx",
    docsUrl: "https://learn.microsoft.com/en-us/bing/search-apis/",
    features: {
      aiAnswer: false,
      newsSearch: true,
      academicSearch: false,
      imageSearch: true,
      videoSearch: true,
      domainFilter: false,
      recencyFilter: true,
      countryFilter: true,
      contentExtraction: false,
      streaming: false,
    },
    pricing: {
      freeCredits: 1000,
      pricePerSearch: 0.003,
    },
  },
  google: {
    id: "google",
    name: "Google Custom Search",
    description: "Google Programmable Search Engine API",
    apiKeyRequired: true,
    apiKeyPlaceholder: "AIzaXXXXXXXXXXXX",
    apiKeyPrefix: "AIza",
    docsUrl: "https://developers.google.com/custom-search/v1/overview",
    features: {
      aiAnswer: false,
      newsSearch: false,
      academicSearch: false,
      imageSearch: true,
      videoSearch: false,
      domainFilter: true,
      recencyFilter: true,
      countryFilter: true,
      contentExtraction: false,
      streaming: false,
    },
    pricing: {
      freeCredits: 100,
      pricePerSearch: 0.005,
    },
  },
  brave: {
    id: "brave",
    name: "Brave Search",
    description: "Privacy-focused search engine API",
    apiKeyRequired: true,
    apiKeyPlaceholder: "BSAxxxxxxxxxxxxx",
    apiKeyPrefix: "BSA",
    docsUrl: "https://brave.com/search/api/",
    features: {
      aiAnswer: true,
      newsSearch: true,
      academicSearch: false,
      imageSearch: true,
      videoSearch: true,
      domainFilter: false,
      recencyFilter: true,
      countryFilter: true,
      contentExtraction: false,
      streaming: false,
    },
    pricing: {
      freeCredits: 2000,
      pricePerSearch: 0.003,
    },
  },
  "google-ai": {
    id: "google-ai",
    name: "Google AI Search",
    description: "Gemini grounding with Google Search for real-time web data",
    apiKeyRequired: true,
    apiKeyPlaceholder: "AIzaXXXXXXXXXXXX",
    apiKeyPrefix: "AIza",
    docsUrl: "https://ai.google.dev/gemini-api/docs/google-search",
    features: {
      aiAnswer: true,
      newsSearch: true,
      academicSearch: false,
      imageSearch: false,
      videoSearch: false,
      domainFilter: false,
      recencyFilter: true,
      countryFilter: false,
      contentExtraction: false,
      streaming: true,
    },
    pricing: {
      pricePerSearch: 0.0035,
    },
  },
}

/**
 * Default search provider settings
 */
export const DEFAULT_SEARCH_PROVIDER_SETTINGS: Record<SearchProviderType, SearchProviderSettings> =
  {
    tavily: {
      providerId: "tavily",
      apiKey: "",
      enabled: false,
      priority: 1,
    },
    perplexity: {
      providerId: "perplexity",
      apiKey: "",
      enabled: false,
      priority: 2,
    },
    exa: {
      providerId: "exa",
      apiKey: "",
      enabled: false,
      priority: 3,
    },
    searchapi: {
      providerId: "searchapi",
      apiKey: "",
      enabled: false,
      priority: 4,
    },
    serper: {
      providerId: "serper",
      apiKey: "",
      enabled: false,
      priority: 5,
    },
    serpapi: {
      providerId: "serpapi",
      apiKey: "",
      enabled: false,
      priority: 6,
    },
    bing: {
      providerId: "bing",
      apiKey: "",
      enabled: false,
      priority: 7,
    },
    google: {
      providerId: "google",
      apiKey: "",
      enabled: false,
      priority: 8,
    },
    brave: {
      providerId: "brave",
      apiKey: "",
      enabled: false,
      priority: 9,
    },
    "google-ai": {
      providerId: "google-ai",
      apiKey: "",
      enabled: false,
      priority: 10,
    },
  }

/**
 * Get enabled providers sorted by priority
 */
export function isProviderConfigured(
  providerId: SearchProviderType,
  settings?: Partial<SearchProviderSettings>
): boolean {
  if (!settings?.apiKey || settings.apiKey.trim() === "") return false

  if (providerId === "google") {
    return !!settings.cx && settings.cx.trim() !== ""
  }

  return true
}

export function getEnabledProviders(
  settings: Partial<Record<SearchProviderType, SearchProviderSettings>>
): SearchProviderSettings[] {
  return Object.values(settings)
    .filter((p): p is SearchProviderSettings => !!p)
    .filter((p) => p.enabled && isProviderConfigured(p.providerId, p))
    .sort((a, b) => a.priority - b.priority)
}

/**
 * Validate API key format for a provider
 */
export function validateApiKey(provider: SearchProviderType, apiKey: string): boolean {
  const config = SEARCH_PROVIDERS[provider]
  if (!config) return false

  if (!apiKey || apiKey.trim() === "") return false

  if (config.apiKeyPrefix) {
    return apiKey.startsWith(config.apiKeyPrefix) && apiKey.length > config.apiKeyPrefix.length + 10
  }

  return apiKey.length >= 10
}

/**
 * Source verification mode
 * - 'ask': Ask user before using sources
 * - 'auto': Automatically verify and use sources
 * - 'disabled': Skip source verification
 */
export type SourceVerificationMode = "ask" | "auto" | "disabled"

/**
 * Source type classification
 */
export type SourceType =
  | "government"
  | "academic"
  | "news"
  | "reference"
  | "organization"
  | "corporate"
  | "blog"
  | "social"
  | "forum"
  | "unknown"

/**
 * Credibility level
 */
export type CredibilityLevel = "high" | "medium" | "low" | "unknown"

/**
 * Source verification result for a single source
 */
export interface SourceVerification {
  url: string
  domain: string
  rootDomain: string
  sourceType: SourceType
  credibilityScore: number
  credibilityLevel: CredibilityLevel
  isHttps: boolean
  trustIndicators: string[]
  warningIndicators: string[]
  userMarked?: "trusted" | "blocked" | null
}

/**
 * Cross-validation result between sources
 */
export interface CrossValidationResult {
  claim: string
  supportingSources: string[]
  contradictingSources: string[]
  neutralSources: string[]
  consensusScore: number
}

/**
 * Enhanced search result with verification data
 */
export interface VerifiedSearchResult extends SearchResult {
  verification?: SourceVerification
  isEnabled: boolean
}

/**
 * Enhanced search response with verification
 */
export interface VerifiedSearchResponse extends Omit<SearchResponse, "results"> {
  results: VerifiedSearchResult[]
  verificationReport?: {
    totalSources: number
    highCredibility: number
    mediumCredibility: number
    lowCredibility: number
    averageCredibility: number
    crossValidation?: CrossValidationResult[]
    recommendations: string[]
  }
}

/**
 * Source verification settings
 */
export interface SourceVerificationSettings {
  enabled: boolean
  mode: SourceVerificationMode
  minimumCredibilityScore: number
  autoFilterLowCredibility: boolean
  showVerificationBadges: boolean
  trustedDomains: string[]
  blockedDomains: string[]
  enableCrossValidation: boolean
}

/**
 * Default source verification settings
 */
export const DEFAULT_SOURCE_VERIFICATION_SETTINGS: SourceVerificationSettings = {
  enabled: true,
  mode: "ask",
  minimumCredibilityScore: 0.3,
  autoFilterLowCredibility: false,
  showVerificationBadges: true,
  trustedDomains: [],
  blockedDomains: [],
  enableCrossValidation: true,
}

/** Per-provider search usage entry */
export interface SearchUsageEntry {
  searchCount: number
  lastUsedAt: number | null
  totalResponseTime: number
  errorCount: number
}

/** Custom research source */
export interface CustomSearchSource {
  id: string
  name: string
  icon?: string
}

/** Search safe search level */
export type SafeSearchLevel = "off" | "moderate" | "strict"

/** Default usage stats for a provider */
export function createDefaultSearchUsageEntry(): SearchUsageEntry {
  return {
    searchCount: 0,
    lastUsedAt: null,
    totalResponseTime: 0,
    errorCount: 0,
  }
}

/** Create default usage stats for all providers */
export function createDefaultSearchUsageStats(): Record<SearchProviderType, SearchUsageEntry> {
  const stats: Partial<Record<SearchProviderType, SearchUsageEntry>> = {}
  for (const id of Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]) {
    stats[id] = createDefaultSearchUsageEntry()
  }
  return stats as Record<SearchProviderType, SearchUsageEntry>
}

export interface SearchProviderHealth {
  status: "healthy" | "degraded" | "unhealthy" | "unknown"
  avgLatency: number
  successRate: number
  circuitBreakerOpen: boolean
  lastChecked: number
}
