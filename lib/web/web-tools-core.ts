/**
 * Shared implementation for the first-class web tools (web_search + web_fetch).
 *
 * Extracted verbatim from `plugins/web-tools/src/index.ts` so the logic can be
 * reused by BOTH the promoted built-in tools (host-routed via
 * `lib/claude/web-builtin-tools.ts`) and the web-tools plugin's own wrappers.
 * The only behavioral change vs. the plugin is that `webSearch` takes
 * `providerSettings` as an explicit parameter instead of reading the renderer
 * settings store — this is what lets it run on the CLI host (no Zustand store)
 * as well as the desktop renderer.
 *
 * Reuses the app's existing infrastructure rather than reimplementing:
 *   - multi-provider web search → `lib/search/search-service`
 *   - readable HTML → text extraction → `lib/document/parsers/html-parser`
 */

import { search } from "@/lib/search/search-service"
import {
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  isProviderConfigured,
  type SearchProviderType,
  type SearchProviderSettings,
  type SearchOptions,
  type SearchResponse,
  type SearchResult,
  type SourceVerificationSettings,
} from "@/lib/search/types"
import { optimizeSearchQuery } from "@/lib/search/search-query-optimizer"
import { verifySource, sortByCredibility } from "@/lib/search/source-verification"
import { parseHTML } from "@cognia/document/parsers/html-parser"
import { fetchCacheKey, type FetchCacheLike } from "@/lib/web/fetch-cache"

/** How `web_fetch` should present the response body. */
export type FetchFormat = "auto" | "text" | "raw"

export interface WebFetchArgs {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  maxBytes?: number
  /**
   * `auto` (default) extracts readable text for HTML responses and returns the
   * raw body for everything else; `text` forces extraction; `raw` skips it.
   */
  format?: FetchFormat
  /**
   * Query-focused extraction. When set (and a `summarize` dep is available),
   * the extracted page text is distilled to just the content relevant to this
   * question before being returned — collapsing a full page (tens of thousands
   * of tokens) to a short, on-topic answer. Falls back to truncated page text
   * when no summarizer is available or the call fails.
   */
  prompt?: string
}

export interface WebSearchArgs {
  query: string
  /** Force a specific provider; defaults to the user's configured default. */
  provider?: SearchProviderType
  maxResults?: number
}

export interface WebFetchDeps {
  /** Optional User-Agent header for outbound requests. */
  userAgent?: string
  /** Injectable fetch for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Query-focused extractor. When present and `args.prompt` is set, the
   * extracted page text is passed through this to return only the relevant
   * content. The host builds it from the cheap utility model
   * (see {@link buildFetchExtractor}); absent on hosts without a usable model
   * key, in which case the full (truncated) page text is returned.
   */
  summarize?: FetchSummarize
  /** Forwarded to `summarize` so an aborted turn cancels the extraction call. */
  signal?: AbortSignal
  /** Optional TTL/LRU cache for repeated GETs (host passes `getFetchCache()`). */
  cache?: FetchCacheLike
}

/** Distill page text down to just the content relevant to `prompt`. */
export type FetchSummarize = (text: string, prompt: string, signal?: AbortSignal) => Promise<string>

/**
 * Minimal cheap-model client shape (a subset of `LlmClient` from
 * `lib/twin/distill/llm`) — declared locally so the pure core doesn't import
 * the renderer LLM stack.
 */
export interface FetchExtractorClient {
  complete(
    prompt: string,
    options?: {
      system?: string
      temperature?: number
      maxTokens?: number
      abortSignal?: AbortSignal
    }
  ): Promise<string>
}

/** System prompt for query-focused page extraction. */
export const FETCH_EXTRACT_SYSTEM_PROMPT =
  "You extract only the parts of a web page that answer the user's question. " +
  "Return the relevant facts, quotes, numbers, names, dates and URLs concisely, " +
  "preserving them verbatim. If the page does not address the question, say so " +
  "in one line. Do not add a preamble like 'Here is'. Write in the question's language."

/** Hard ceiling on page characters fed to the extractor (keeps the cheap call bounded). */
const FETCH_EXTRACT_INPUT_MAX = 32 * 1024

/**
 * Wrap a cheap-model client into a {@link FetchSummarize}. The host (renderer
 * via `buildUtilityLlmClient`, CLI via its own resolver) calls this once and
 * passes the result as `deps.summarize`.
 */
export function buildFetchExtractor(client: FetchExtractorClient): FetchSummarize {
  return async (text, prompt, signal) => {
    const bounded =
      text.length > FETCH_EXTRACT_INPUT_MAX ? text.slice(0, FETCH_EXTRACT_INPUT_MAX) : text
    const out = await client.complete(`Question:\n${prompt}\n\nPage content:\n${bounded}`, {
      system: FETCH_EXTRACT_SYSTEM_PROMPT,
      temperature: 0.2,
      maxTokens: 1024,
      abortSignal: signal,
    })
    return (out ?? "").trim()
  }
}

/** Reused search-result cache shape (a subset of `lib/search/search-cache`'s `SearchCache`). */
export interface SearchResultCacheLike {
  get(query: string, provider?: SearchProviderType, options?: SearchOptions): SearchResponse | null
  set(
    query: string,
    response: SearchResponse,
    provider?: SearchProviderType,
    options?: SearchOptions
  ): void
}

export interface WebSearchDeps {
  /** The user's configured search-provider settings (keys, enabled flags). */
  providerSettings?: Partial<Record<SearchProviderType, SearchProviderSettings>>
  /** Default max results when the caller doesn't specify. */
  searchMaxResults?: number
  /** Whether to fall back to other providers on failure. Default true. */
  searchFallbackEnabled?: boolean
  /**
   * The user's configured default search options (type, depth, recency,
   * country, language, include/exclude domains, includeAnswer). Forwarded to
   * the search service so the agent honors Settings → Search instead of
   * ignoring it.
   */
  searchOptions?: SearchOptions
  /**
   * Reused result cache (`getSearchCache()`); when present, identical queries in
   * the cache window are served without re-hitting the provider or re-billing.
   */
  searchCache?: SearchResultCacheLike
  /**
   * Source-verification settings. When `enabled`, results are filtered by
   * blocked domains / minimum credibility and sorted by credibility, reusing
   * the existing `lib/search/source-verification` engine.
   */
  sourceVerification?: SourceVerificationSettings
  /** Strip filler from the model's query before searching. Default true. */
  optimizeQuery?: boolean
}

/** Default cap on the raw body returned to the model (chars). */
const DEFAULT_MAX = 64 * 1024
/** Default cap on EXTRACTED page text when the caller didn't set `maxBytes`. */
const DEFAULT_EXTRACT_MAX = 40 * 1024
/** Per-result snippet cap in `web_search` results. */
const SNIPPET_MAX = 300

/**
 * Perform an HTTP request and return readable content for the model.
 *
 * For HTML responses we return ONLY the extracted `text` (+ `title`) — the raw
 * markup the model shouldn't wade through is dropped, which is the single
 * biggest token saving here. The raw `body` is returned only for non-HTML
 * responses, `format: "raw"`, or when extraction yields nothing. When
 * `args.prompt` + `deps.summarize` are present the extracted text is further
 * distilled to just the relevant content. GET results are served from / stored
 * in `deps.cache` when provided.
 */
export async function webFetch(args: WebFetchArgs, deps: WebFetchDeps = {}): Promise<unknown> {
  if (!args.url) {
    return { ok: false as const, error: "url is required" }
  }
  const method = args.method ?? "GET"
  const format: FetchFormat = args.format ?? "auto"
  // Only idempotent, body-less GETs are safe to cache; the prompt is part of
  // the key because it changes the distilled output.
  const cacheable = method.toUpperCase() === "GET" && !args.body
  const cacheKey = cacheable
    ? fetchCacheKey({
        url: args.url,
        method,
        format,
        maxBytes: args.maxBytes,
        prompt: args.prompt,
      })
    : ""
  if (deps.cache && cacheable) {
    const hit = deps.cache.get(cacheKey)
    if (hit != null) return hit
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  const headers: Record<string, string> = { ...(args.headers ?? {}) }
  if (deps.userAgent && !headers["User-Agent"]) headers["User-Agent"] = deps.userAgent
  try {
    const res = await fetchImpl(args.url, { method, headers, body: args.body })
    const cap = args.maxBytes && args.maxBytes > 0 ? args.maxBytes : DEFAULT_MAX
    const extractCap = args.maxBytes && args.maxBytes > 0 ? cap : DEFAULT_EXTRACT_MAX
    const raw = await res.text()
    const contentType = res.headers.get?.("content-type") ?? ""
    const wantsExtract = format !== "raw" && (format === "text" || /html/i.test(contentType))

    let extracted: { text: string; truncated: boolean; title?: string } | undefined
    if (wantsExtract && res.ok && raw) {
      try {
        const parsed = await parseHTML(raw, { includeLinks: false, includeImages: false })
        let text = parsed.text?.trim() ?? ""
        if (text) {
          // Query-focused distillation (Claude-Code-style): collapse the page to
          // just what `prompt` asked for. Never throws — falls back to truncation.
          if (args.prompt && deps.summarize) {
            try {
              const focused = (await deps.summarize(text, args.prompt, deps.signal))?.trim()
              if (focused) text = focused
            } catch {
              // Keep the extracted page text.
            }
          }
          const truncated = text.length > extractCap
          extracted = {
            text: truncated ? text.slice(0, extractCap) : text,
            truncated,
            ...(parsed.title ? { title: parsed.title } : {}),
          }
        }
      } catch {
        // Malformed HTML — fall through to the raw body below.
      }
    }

    const result =
      extracted != null
        ? {
            ok: res.ok,
            status: res.status,
            url: args.url,
            contentType,
            text: extracted.text,
            truncated: extracted.truncated,
            ...(extracted.title ? { title: extracted.title } : {}),
          }
        : {
            ok: res.ok,
            status: res.status,
            url: args.url,
            contentType,
            body: raw.length > cap ? raw.slice(0, cap) : raw,
            truncated: raw.length > cap,
          }

    if (deps.cache && cacheable && res.ok) deps.cache.set(cacheKey, result)
    return result
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Filter + reorder results through the source-verification engine when the
 * user enabled it: drop blocked domains, drop below-minimum-credibility results
 * (when auto-filter is on), then sort most-credible-first. Pure; no-op when
 * verification is disabled.
 */
function applySourceVerification(
  results: SearchResult[],
  sv: SourceVerificationSettings | undefined
): SearchResult[] {
  if (!sv?.enabled || results.length === 0) return results
  const blocked = (sv.blockedDomains ?? []).map((d) => d.toLowerCase().trim()).filter(Boolean)
  let out = results
  if (blocked.length > 0) {
    out = out.filter((r) => {
      const domain = verifySource(r.url).domain.toLowerCase()
      return !blocked.some((b) => domain === b || domain.endsWith(`.${b}`))
    })
  }
  if (sv.autoFilterLowCredibility) {
    out = out.filter((r) => verifySource(r.url).credibilityScore >= sv.minimumCredibilityScore)
  }
  return sortByCredibility(out, "desc")
}

/** Map a raw `SearchResponse` into the compact, token-bounded tool result. */
function shapeSearchResponse(
  query: string,
  response: SearchResponse,
  sv: SourceVerificationSettings | undefined
): unknown {
  const verified = applySourceVerification(response.results, sv)
  const withBadges = Boolean(sv?.enabled && sv.showVerificationBadges)
  return {
    ok: true as const,
    query,
    provider: response.provider,
    answer: response.answer ?? null,
    // Structured results only — the previous `formatted` markdown block
    // duplicated every snippet a second time. Each snippet is capped so a
    // chatty provider can't blow up the tool-result token cost; the model
    // can `web_fetch` a result URL when it needs the full page.
    results: verified.map((r) => ({
      title: r.title,
      url: r.url,
      content:
        typeof r.content === "string" && r.content.length > SNIPPET_MAX
          ? r.content.slice(0, SNIPPET_MAX) + "…"
          : r.content,
      score: r.score,
      ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      ...(withBadges ? { credibility: verifySource(r.url).credibilityLevel } : {}),
    })),
  }
}

/** Multi-provider web search over the user's configured providers. */
export async function webSearch(args: WebSearchArgs, deps: WebSearchDeps = {}): Promise<unknown> {
  const rawQuery = typeof args.query === "string" ? args.query.trim() : ""
  if (!rawQuery) {
    return { ok: false as const, error: "query is required" }
  }
  // Strip filler ("please tell me about …") so the provider sees a focused
  // query — better hits and a smaller, stabler cache key.
  const query = deps.optimizeQuery === false ? rawQuery : optimizeSearchQuery(rawQuery) || rawQuery

  const providerSettings = deps.providerSettings ?? DEFAULT_SEARCH_PROVIDER_SETTINGS
  const configured = Object.values(providerSettings).filter(
    (p) => p.enabled && isProviderConfigured(p.providerId, p)
  )
  if (configured.length === 0) {
    return {
      ok: false as const,
      error:
        "No web search provider is configured. Enable one and add its API key in Settings → Search.",
    }
  }

  const maxResults =
    typeof args.maxResults === "number"
      ? args.maxResults
      : typeof deps.searchMaxResults === "number"
        ? deps.searchMaxResults
        : undefined
  const searchOptions: SearchOptions = {
    ...(deps.searchOptions ?? {}),
    ...(maxResults != null ? { maxResults } : {}),
  }

  // Cache hit — reuse the existing search-result cache (shared with the search UI).
  if (deps.searchCache) {
    const hit = deps.searchCache.get(query, args.provider, searchOptions)
    if (hit) return shapeSearchResponse(query, hit, deps.sourceVerification)
  }

  try {
    const response = await search(query, {
      providerSettings,
      ...(args.provider ? { provider: args.provider } : {}),
      ...searchOptions,
      fallbackEnabled: deps.searchFallbackEnabled ?? true,
    })
    if (deps.searchCache) deps.searchCache.set(query, response, args.provider, searchOptions)
    return shapeSearchResponse(query, response, deps.sourceVerification)
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
  }
}
