/**
 * Search type definitions
 * Unified types for multi-provider web search
 */

import type { GenerationSeam } from "./generation-seam"

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
  | "deepseek"
  | "tinyfish"
  | "searxng"

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
  /**
   * Rank-derived ordering score. Provider-specific scale; never factual
   * confidence and never a credibility verdict.
   */
  score: number
  /**
   * Full or long-form page text a provider returned because the caller asked
   * for it (`includeRawContent`). Absent when it was not requested; consumers
   * bound it themselves (see `SEARCH_EXCERPT_MAX_CHARS`).
   */
  rawContent?: string
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
  /**
   * Provider-neutral safe-search level. `strict` is mandatory: a provider that
   * cannot enforce it at the wire is ineligible before any request. `off` and
   * `moderate` are advisory unless {@link safeSearchRequired} is set; a
   * provider that cannot honour an advisory level reports it in
   * `SearchResponse.diagnostics.degradedControls`.
   */
  safeSearch?: SafeSearchLevel
  /** Make a `moderate` safe-search level mandatory instead of advisory. */
  safeSearchRequired?: boolean
  /**
   * Provider-scoped SERP engine (e.g. `google` / `bing` / `baidu` on SearchAPI,
   * or a SearXNG engine name). Omitted ⇒ the provider's own default. An engine
   * the serving provider does not list fails validation before any request.
   */
  engine?: string
  /**
   * Runtime-only cancellation signal threaded to every adapter request. Never
   * persisted; providers forward it to their transport.
   */
  signal?: AbortSignal
  /**
   * Generation seam for a provider whose search is itself a model generation
   * (`google-ai`: one Gemini `:generateContent` per search). Runtime-only —
   * never persisted — and read by no other provider. The host passes the
   * ledgered seam when its Router + Fusion surface is on (ADR-0188 D27);
   * absent, the request goes out exactly as before. See `./generation-seam.ts`.
   */
  generate?: GenerationSeam
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
  /** The search type the serving adapter actually executed. */
  searchType?: SearchType
  /** The SERP engine the serving adapter actually used, when it has engines. */
  engine?: string
  /** What the executor changed or could not honour; absent when nothing to report. */
  diagnostics?: SearchDiagnostics
}

/**
 * Bounded, content-free notes about how a response was produced. Never holds
 * the query, URLs or result text.
 */
export interface SearchDiagnostics {
  /** Advisory controls the serving provider could not honour at the wire. */
  degradedControls?: Array<
    "safeSearch" | "recency" | "country" | "language" | "domains" | "searchType"
  >
  /**
   * Why the provider's synthesized `answer` was removed: the grounding set it
   * was written from lost at least one source to policy filtering.
   */
  answerCleared?: "policy-filtered"
  /** Results / images removed by hard domain or source-verification policy. */
  removedByPolicy?: { results: number; images: number }
  /** Providers attempted, in order (registered ids only). */
  attemptedProviders?: SearchProviderType[]
  /** True when the response came from the in-memory cache. */
  cacheHit?: boolean
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
 * How Cognia reaches a provider. Four different integration classes, kept
 * apart so a generating search is never mistaken for raw SERP output:
 * - `api`: an ordinary vendor search API returning ranked documents
 * - `serp`: a SERP scraper/aggregator API fronting one or more engines
 * - `self-hosted`: a user-run endpoint (SearXNG); no vendor key
 * - `grounding`: a model generation grounded in search (`google-ai`); its
 *   results are cited sources of a generated answer, and every call is a
 *   billed model generation
 */
export type SearchIntegrationKind = "api" | "serp" | "self-hosted" | "grounding"

/**
 * Lifecycle of a registered provider. Ids are never deleted: a retired entry
 * keeps the user's stored record but is excluded from every execution,
 * connection-test and fallback path.
 */
export type SearchProviderLifecycle =
  | { status: "active" }
  /** Usable by existing accounts until `endDate` (ISO date); closed to new customers. */
  | { status: "legacy"; endDate: string }
  /** Vendor shut the API down on `retiredOn` (ISO date). */
  | { status: "retired"; retiredOn: string }

/**
 * What a provider's configuration must contain before it is eligible.
 * - `api-key`: a nonempty key
 * - `api-key+cx`: a key plus a Programmable Search Engine id (`google`)
 * - `endpoint`: a validated `baseUrl`, no key (`searxng`)
 */
export type SearchProviderAuth = "api-key" | "api-key+cx" | "endpoint"

/** One SERP engine a provider can serve and Cognia can normalize. */
export interface SearchEngineDescriptor {
  id: string
  label: string
}

/**
 * Search provider configuration
 */
export interface SearchProviderConfig {
  id: SearchProviderType
  name: string
  description: string
  integration: SearchIntegrationKind
  lifecycle: SearchProviderLifecycle
  auth: SearchProviderAuth
  /**
   * The operations this vendor offers through an integrated adapter. `read`
   * means a vendor Reader adapter exists (`lib/web/reader/vendor-readers`);
   * enabling Search never enables it.
   */
  operations: { search: boolean; read: boolean }
  /** Engines selectable for `general` search; absent ⇒ the provider has one fixed engine. */
  engines?: readonly SearchEngineDescriptor[]
  /** Engine used when none is configured. */
  defaultEngine?: string
  apiKeyRequired: boolean
  apiKeyPlaceholder: string
  apiKeyPrefix?: string
  docsUrl: string
  /**
   * Advertised capabilities. Must agree with the adapter mapping in
   * `search-type-router` (`getEffectiveSearchCapabilities`); a test pins the
   * two together so a badge can never claim a specialization the adapter does
   * not implement.
   */
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
  /**
   * Provider-scoped default SERP engine. Must be one of the provider's
   * `SEARCH_PROVIDERS[id].engines`; absent ⇒ `defaultEngine`.
   */
  engine?: string
  /**
   * Self-hosted endpoint base URL. Accepted only for `endpoint`-auth providers
   * (SearXNG) and validated by `validateSearchEndpoint`: absolute http(s), no
   * embedded credentials, query or fragment; the adapter appends `/search`.
   */
  baseUrl?: string
  /**
   * Explicit endpoint grant for a private/loopback `baseUrl` (or plain HTTP,
   * which is only accepted for private hosts). Scoped to this provider's
   * search endpoint: it never widens what `web_fetch` may reach. Host-local —
   * excluded from portable profiles, so an imported profile has to be granted
   * again on the receiving host.
   */
  allowPrivateEndpoint?: boolean
  /**
   * Generation model for a `grounding` provider (`google-ai`). Absent ⇒
   * `GOOGLE_AI_DEFAULT_MODEL`. Must pass `supportsGoogleSearchGrounding`.
   */
  model?: string
  enabled: boolean
  priority: number
  /** Persisted per-provider defaults. The runtime-only `generate` seam is never one of them. */
  defaultOptions?: Partial<Omit<SearchOptions, "generate" | "signal">>
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

const ACTIVE: SearchProviderLifecycle = { status: "active" }

/**
 * Search provider definitions
 */
export const SEARCH_PROVIDERS: Record<SearchProviderType, SearchProviderConfig> = {
  tavily: {
    id: "tavily",
    name: "Tavily",
    description: "AI-optimized search engine with answer generation",
    integration: "api",
    lifecycle: ACTIVE,
    auth: "api-key",
    operations: { search: true, read: true },
    apiKeyRequired: true,
    apiKeyPlaceholder: "tvly-xxxxxxxxxxxxx",
    apiKeyPrefix: "tvly-",
    docsUrl: "https://docs.tavily.com",
    features: {
      aiAnswer: true,
      newsSearch: true,
      academicSearch: false,
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
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    description: "High-quality search with recency and geo filters",
    integration: "api",
    lifecycle: ACTIVE,
    auth: "api-key",
    operations: { search: true, read: false },
    apiKeyRequired: true,
    apiKeyPlaceholder: "pplx-xxxxxxxxxxxxx",
    apiKeyPrefix: "pplx-",
    docsUrl: "https://docs.perplexity.ai",
    features: {
      aiAnswer: false,
      newsSearch: false,
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
    integration: "api",
    lifecycle: ACTIVE,
    auth: "api-key",
    operations: { search: true, read: true },
    apiKeyRequired: true,
    apiKeyPlaceholder: "exa-xxxxxxxxxxxxx",
    docsUrl: "https://docs.exa.ai",
    features: {
      aiAnswer: false,
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
    integration: "serp",
    lifecycle: ACTIVE,
    auth: "api-key",
    operations: { search: true, read: false },
    engines: [
      { id: "google", label: "Google" },
      { id: "bing", label: "Bing" },
      { id: "baidu", label: "Baidu" },
      { id: "yandex", label: "Yandex" },
      { id: "duckduckgo", label: "DuckDuckGo" },
    ],
    defaultEngine: "google",
    apiKeyRequired: true,
    apiKeyPlaceholder: "xxxxxxxxxxxxx",
    docsUrl: "https://www.searchapi.io/docs",
    features: {
      aiAnswer: true,
      newsSearch: true,
      academicSearch: true,
      imageSearch: true,
      videoSearch: false,
      domainFilter: false,
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
    integration: "serp",
    lifecycle: ACTIVE,
    auth: "api-key",
    operations: { search: true, read: false },
    apiKeyRequired: true,
    apiKeyPlaceholder: "xxxxxxxxxxxxx",
    docsUrl: "https://serper.dev",
    features: {
      aiAnswer: true,
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
    integration: "serp",
    lifecycle: ACTIVE,
    auth: "api-key",
    operations: { search: true, read: false },
    engines: [
      { id: "google", label: "Google" },
      { id: "bing", label: "Bing" },
      { id: "baidu", label: "Baidu" },
      { id: "yahoo", label: "Yahoo" },
      { id: "yandex", label: "Yandex" },
      { id: "duckduckgo", label: "DuckDuckGo" },
    ],
    defaultEngine: "google",
    apiKeyRequired: true,
    apiKeyPlaceholder: "xxxxxxxxxxxxx",
    docsUrl: "https://serpapi.com/search-api",
    features: {
      aiAnswer: true,
      newsSearch: true,
      academicSearch: false,
      imageSearch: true,
      videoSearch: false,
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
    description: "Microsoft Bing Web Search API (retired by Microsoft on 2025-08-11)",
    integration: "api",
    // https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
    lifecycle: { status: "retired", retiredOn: "2025-08-11" },
    auth: "api-key",
    operations: { search: true, read: false },
    apiKeyRequired: true,
    apiKeyPlaceholder: "xxxxxxxxxxxxx",
    docsUrl: "https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement",
    features: {
      aiAnswer: false,
      newsSearch: true,
      academicSearch: false,
      imageSearch: true,
      videoSearch: false,
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
    description: "Google Programmable Search Engine API (closed to new customers)",
    integration: "api",
    // https://developers.google.com/custom-search/v1/overview
    lifecycle: { status: "legacy", endDate: "2027-01-01" },
    auth: "api-key+cx",
    operations: { search: true, read: false },
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
      domainFilter: false,
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
    integration: "api",
    lifecycle: ACTIVE,
    auth: "api-key",
    operations: { search: true, read: false },
    apiKeyRequired: true,
    apiKeyPlaceholder: "BSAxxxxxxxxxxxxx",
    apiKeyPrefix: "BSA",
    docsUrl: "https://brave.com/search/api/",
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
      freeCredits: 2000,
      pricePerSearch: 0.003,
    },
  },
  "google-ai": {
    id: "google-ai",
    name: "Google AI Search",
    description: "Gemini generation grounded in Google Search; every search is a billed model call",
    integration: "grounding",
    lifecycle: ACTIVE,
    auth: "api-key",
    operations: { search: true, read: false },
    apiKeyRequired: true,
    apiKeyPlaceholder: "AIzaXXXXXXXXXXXX",
    apiKeyPrefix: "AIza",
    docsUrl: "https://ai.google.dev/gemini-api/docs/google-search",
    features: {
      aiAnswer: true,
      newsSearch: false,
      academicSearch: false,
      imageSearch: false,
      videoSearch: false,
      domainFilter: false,
      recencyFilter: false,
      countryFilter: false,
      contentExtraction: false,
      streaming: false,
    },
    pricing: {
      pricePerSearch: 0.0035,
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek Search",
    description: "DeepSeek web Search and Fetch APIs; Search and Reader are enabled separately",
    integration: "api",
    lifecycle: ACTIVE,
    auth: "api-key",
    operations: { search: true, read: true },
    apiKeyRequired: true,
    apiKeyPlaceholder: "sk-xxxxxxxxxxxxx",
    apiKeyPrefix: "sk-",
    docsUrl: "https://api-docs.deepseek.com/zh-cn/guides/search/",
    features: {
      aiAnswer: false,
      newsSearch: false,
      academicSearch: false,
      imageSearch: false,
      videoSearch: false,
      domainFilter: true,
      recencyFilter: true,
      countryFilter: false,
      contentExtraction: true,
      streaming: false,
    },
  },
  tinyfish: {
    id: "tinyfish",
    name: "TinyFish",
    description: "TinyFish Search and Fetch APIs; Search and Reader are enabled separately",
    integration: "api",
    lifecycle: ACTIVE,
    auth: "api-key",
    operations: { search: true, read: true },
    apiKeyRequired: true,
    apiKeyPlaceholder: "xxxxxxxxxxxxx",
    docsUrl: "https://docs.tinyfish.ai/search-api/reference",
    features: {
      aiAnswer: false,
      newsSearch: true,
      academicSearch: true,
      imageSearch: false,
      videoSearch: false,
      domainFilter: true,
      recencyFilter: true,
      countryFilter: false,
      contentExtraction: false,
      streaming: false,
    },
  },
  searxng: {
    id: "searxng",
    name: "SearXNG",
    description: "Your own SearXNG instance (JSON output must be enabled); no vendor key",
    integration: "self-hosted",
    lifecycle: ACTIVE,
    auth: "endpoint",
    operations: { search: true, read: false },
    apiKeyRequired: false,
    apiKeyPlaceholder: "",
    docsUrl: "https://docs.searxng.org/dev/search_api.html",
    features: {
      aiAnswer: false,
      newsSearch: true,
      academicSearch: true,
      imageSearch: true,
      videoSearch: true,
      domainFilter: false,
      recencyFilter: true,
      countryFilter: false,
      contentExtraction: false,
      streaming: false,
    },
  },
}

/**
 * Default search provider settings
 */
export const DEFAULT_SEARCH_PROVIDER_SETTINGS: Record<SearchProviderType, SearchProviderSettings> =
  {
    tavily: { providerId: "tavily", apiKey: "", enabled: false, priority: 1 },
    perplexity: { providerId: "perplexity", apiKey: "", enabled: false, priority: 2 },
    exa: { providerId: "exa", apiKey: "", enabled: false, priority: 3 },
    searchapi: { providerId: "searchapi", apiKey: "", enabled: false, priority: 4 },
    serper: { providerId: "serper", apiKey: "", enabled: false, priority: 5 },
    serpapi: { providerId: "serpapi", apiKey: "", enabled: false, priority: 6 },
    bing: { providerId: "bing", apiKey: "", enabled: false, priority: 7 },
    google: { providerId: "google", apiKey: "", enabled: false, priority: 8 },
    brave: { providerId: "brave", apiKey: "", enabled: false, priority: 9 },
    "google-ai": { providerId: "google-ai", apiKey: "", enabled: false, priority: 10 },
    deepseek: { providerId: "deepseek", apiKey: "", enabled: false, priority: 11 },
    tinyfish: { providerId: "tinyfish", apiKey: "", enabled: false, priority: 12 },
    searxng: { providerId: "searxng", apiKey: "", enabled: false, priority: 13 },
  }

/** True when the vendor shut the provider's API down; such a provider never runs. */
export function isProviderRetired(providerId: SearchProviderType): boolean {
  return SEARCH_PROVIDERS[providerId]?.lifecycle.status === "retired"
}

/** Why an endpoint is not acceptable for a self-hosted provider. */
export type SearchEndpointIssue =
  | "missing"
  | "invalid-url"
  | "unsupported-scheme"
  | "embedded-credentials"
  | "query-or-fragment"
  | "insecure-public-endpoint"

export interface SearchEndpointValidation {
  ok: boolean
  issue?: SearchEndpointIssue
  /** Normalized base (no trailing slash) when `ok`. */
  baseUrl?: string
  /** True when the host is loopback/private/link-local (needs an explicit endpoint grant). */
  isPrivate?: boolean
}

function isPrivateEndpointHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "local" || host.endsWith(".local")) return true
  if (host.includes(":")) {
    // IPv6: loopback, unique-local fc00::/7, link-local fe80::/10.
    return host === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)
  }
  const parts = host.split(".")
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false
  const [a, b] = parts.map(Number)
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

/**
 * Validate a self-hosted search endpoint. Accepts an absolute http(s) URL with
 * an optional deployment path prefix; rejects credentials, query and fragment.
 * A public host must use HTTPS; plain HTTP is only acceptable for a private
 * host, and a private host additionally needs an explicit endpoint grant on a
 * host that can enforce it (checked by the caller, not here).
 */
export function validateSearchEndpoint(raw: string | undefined): SearchEndpointValidation {
  const value = raw?.trim()
  if (!value) return { ok: false, issue: "missing" }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, issue: "invalid-url" }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, issue: "unsupported-scheme" }
  }
  if (url.username || url.password) return { ok: false, issue: "embedded-credentials" }
  if (url.search || url.hash || value.includes("?") || value.includes("#")) {
    return { ok: false, issue: "query-or-fragment" }
  }
  const isPrivate = isPrivateEndpointHost(url.hostname)
  if (url.protocol === "http:" && !isPrivate) {
    return { ok: false, issue: "insecure-public-endpoint" }
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/search$/, "")
  return { ok: true, baseUrl: `${url.origin}${path}`, isPrivate }
}

/** Why a provider is not eligible to run, in display priority order. */
export type SearchProviderConfigIssue =
  | "retired"
  | "missing-key"
  | "missing-cx"
  | "missing-endpoint"
  | "invalid-endpoint"
  | "endpoint-not-granted"
  | "unsupported-engine"
  | "unsupported-model"

/**
 * Descriptor-driven configuration check. Replaces the old "nonempty key"
 * rule: an endpoint-only provider needs no fake key, a retired provider is
 * never configured, and a stored engine must belong to the provider.
 */
export function getProviderConfigIssues(
  providerId: SearchProviderType,
  settings?: Partial<SearchProviderSettings>
): SearchProviderConfigIssue[] {
  const config = SEARCH_PROVIDERS[providerId]
  if (!config) return ["retired"]
  const issues: SearchProviderConfigIssue[] = []
  if (config.lifecycle.status === "retired") issues.push("retired")
  if (config.auth === "endpoint") {
    if (!settings?.baseUrl?.trim()) issues.push("missing-endpoint")
    else {
      const endpoint = validateSearchEndpoint(settings.baseUrl)
      if (!endpoint.ok) issues.push("invalid-endpoint")
      else if (endpoint.isPrivate && settings.allowPrivateEndpoint !== true) {
        issues.push("endpoint-not-granted")
      }
    }
  } else {
    if (!settings?.apiKey || settings.apiKey.trim() === "") issues.push("missing-key")
    if (config.auth === "api-key+cx" && (!settings?.cx || settings.cx.trim() === "")) {
      issues.push("missing-cx")
    }
  }
  const engine = settings?.engine?.trim()
  if (engine && config.integration !== "self-hosted") {
    if (!config.engines?.some((e) => e.id === engine)) issues.push("unsupported-engine")
  }
  return issues
}

/** Is the provider's stored configuration complete enough to run? (never "online") */
export function isProviderConfigured(
  providerId: SearchProviderType,
  settings?: Partial<SearchProviderSettings>
): boolean {
  return getProviderConfigIssues(providerId, settings).length === 0
}

/**
 * Display state of one provider. `configured` is a statement about stored
 * configuration only; a successful connection test is separate, dated
 * evidence and never implies the provider is online now.
 */
export type SearchProviderState =
  "retired" | "disabled" | "missing-key" | "missing-config" | "configured"

export function getProviderState(
  providerId: SearchProviderType,
  settings?: Partial<SearchProviderSettings>
): SearchProviderState {
  const issues = getProviderConfigIssues(providerId, settings)
  if (issues.includes("retired")) return "retired"
  if (!settings?.enabled) return "disabled"
  if (issues.includes("missing-key")) return "missing-key"
  if (issues.length > 0) return "missing-config"
  return "configured"
}

/**
 * Get enabled providers sorted by priority. Retired and incompletely
 * configured providers are never returned, whatever their stored flags say.
 */
export function getEnabledProviders(
  settings: Partial<Record<SearchProviderType, SearchProviderSettings>>
): SearchProviderSettings[] {
  return Object.values(settings)
    .filter((p): p is SearchProviderSettings => !!p && p.providerId in SEARCH_PROVIDERS)
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
  domain: string
}

/** Persisted custom-source shape from before domains became mandatory. */
export interface LegacyCustomSearchSource {
  id: string
  name: string
  icon?: string
  domain?: string
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

/**
 * Persisted circuit-breaker settings (Settings → Web search → Performance).
 * Runtime state itself is in-memory only.
 */
export interface SearchProviderHealthSettings {
  enabled: boolean
  failureThreshold: number
  cooldownMs: number
}

export const DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS: SearchProviderHealthSettings = {
  enabled: true,
  failureThreshold: 3,
  cooldownMs: 30_000,
}

export const SEARCH_PROVIDER_HEALTH_LIMITS = {
  failureThreshold: { min: 1, max: 10 },
  cooldownMs: { min: 5_000, max: 600_000 },
} as const

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Fill defaults, round, and clamp a persisted/partial health-settings blob to
 * the supported ranges. Non-finite or wrong-typed values fall back to the
 * default for that field.
 */
export function normalizeSearchProviderHealthSettings(
  input?: Partial<SearchProviderHealthSettings> | null
): SearchProviderHealthSettings {
  return {
    enabled:
      typeof input?.enabled === "boolean"
        ? input.enabled
        : DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS.enabled,
    failureThreshold: clampInt(
      input?.failureThreshold,
      SEARCH_PROVIDER_HEALTH_LIMITS.failureThreshold.min,
      SEARCH_PROVIDER_HEALTH_LIMITS.failureThreshold.max,
      DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS.failureThreshold
    ),
    cooldownMs: clampInt(
      input?.cooldownMs,
      SEARCH_PROVIDER_HEALTH_LIMITS.cooldownMs.min,
      SEARCH_PROVIDER_HEALTH_LIMITS.cooldownMs.max,
      DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS.cooldownMs
    ),
  }
}
